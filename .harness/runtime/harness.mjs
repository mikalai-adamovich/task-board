#!/usr/bin/env node
/**
 * Initial schema harness measurement layer — deterministic evaluator / event writer.
 *
 * Scope: measure, do not orchestrate. This script never invents runtime metrics and never
 * launches an agent. Agent execution is external (a human or the IDE agent performs the task);
 * this script evaluates the RESULT of that work against a task contract and writes evidence.
 *
 * Usage:
 *   node .harness/runtime/harness.mjs list
 *   node .harness/runtime/harness.mjs validate [task-id ...]
 *   node .harness/runtime/harness.mjs show <task-id>
 *   node .harness/runtime/harness.mjs taxonomy
 *   node .harness/runtime/harness.mjs evaluate --task=<id> [options]
 *   node .harness/runtime/harness.mjs report [--out=<path>]
 *
 * See .harness/README.md (operator entry point), .harness/docs/schemas.md and
 * .harness/docs/failure-taxonomy.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative as pathRelative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boundarySummary,
  evaluateCheck,
  predicateWarnings,
  runAcceptanceChecks,
  validateAcceptanceBoundaries,
  validateAcceptanceChecks,
  validateHumanAcceptance,
} from './acceptance.mjs';
import { handoffTemplate, validateHandoff, validateHandoffText } from './handoff.mjs';
import { runSelfTest } from '../tests/self-test.mjs';
import {
  ARTIFACT_INTEGRITY_KINDS,
  ARTIFACT_INTEGRITY_STATES,
  HANDOFF_STATUS_TO_VERDICT,
  VERIFIER_VERDICTS,
  classifyLedgerStatus,
  compactVerifier,
  deriveBlockers,
  hasUnresolvedIntegrityBlocker,
  integrityClearance,
  isCoverageIncomplete,
} from './verification-state.mjs';

/** `HARNESS_HOME` relocates the whole harness directory; the self-tests use it to run hermetically. */
const HARNESS_DIR = process.env.HARNESS_HOME
  ? resolve(process.env.HARNESS_HOME)
  : dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(HARNESS_DIR, '..');
const STATE_DIR = join(HARNESS_DIR, 'state');
const CONTROL_DIR = join(STATE_DIR, 'control');
const TASKS_DIR = join(STATE_DIR, 'tasks');
const RUNS_DIR = join(STATE_DIR, 'runs');
const RESULTS_DIR = join(STATE_DIR, 'reports');
/**
 * Runtime telemetry: extracted values only. Generated, not authoritative. The default output home is under `state/`;
 * callers may pass `--out=<path>`.
 */
const TELEMETRY_DIR = join(STATE_DIR, 'telemetry');

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_MAX_CHARS = 2000;
const WORKSPACE_FILE_CAP = 200;
const LEDGER_TRANSITION_RUN_ID_MAX_CHARS = 200;
const LEDGER_TRANSITION_REASON_MAX_CHARS = 400;
const RUN_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DEFAULT_FS = { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync };

/**
 * A1 — why the ledger write is a compare-and-swap and not a lock.
 *
 * `mutateLedger` publishes atomically (temp + fsync + rename), so no TORN file is ever read. Atomic publication is
 * not durability of an UPDATE: the mutation is a read-modify-write, so two concurrent runs on one ledger read the
 * same bytes and both rename, and the slower one silently erases the faster one's verification entry, transition and
 * `failed` status while the losing run's own JSONL still says `ledger_status: failed`. Measured 10/10 before the fix.
 *
 * A lock FILE was deliberately NOT chosen. A lock must be cleaned up on every path including a crash, and a stale
 * lock must be recoverable, or the wedge simply moves from "lost update" to "permanently busy ledger" — a strictly
 * worse failure, because a lost update is at least visible in the run stream and a stuck lock is not. The CAS has no
 * lock to strand: it takes nothing, holds nothing, expires nothing, and cannot deadlock the ordinary single-writer
 * path, whose bytes on disk are unchanged and whose behaviour is byte-for-byte what it was.
 *
 * The guarantee it does buy is the one that matters: **a lost update is impossible, not merely unlikely.** The write
 * happens if and only if the bytes on disk are still exactly the bytes this process read. Anything else is a REFUSAL
 * with a named reason — never a silent overwrite, and never a merge the operator did not ask for.
 */
const LEDGER_WRITE_CONFLICT = 'LEDGER_WRITE_CONFLICT';
/** The read side of the same contract: the digest of what is on disk right now, or `null` when unreadable. */
function ledgerBytesDigest(runId) {
  try {
    const path = ledgerPath(runId);

    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
  } catch {
    return null;
  }
}

/** Untracked paths that are environment noise rather than task work (worktree symlinks, build output). */
const NOISE_UNTRACKED = ['node_modules', 'dist', '.angular', '.wrangler', '.harness'];

/**
 * Commit-bound evaluation records (Phase implementation, Option A).
 *
 * A judged commit is recorded FULL, never abbreviated: a prefix is exactly what makes two commits confusable, and the
 * pre-existing HEAD-mismatch check is prefix-tolerant. Every optional observation is normalised to `null` on write and
 * accepted as `null` on read, because `mutateLedger` does not validate on write while `loadLedger` fails closed on read
 * — a writer/reader disagreement would reclassify the ledger as `rejected` on the next read and remove it permanently
 * from `newestLedgerForTask`, `ledger show` and `report`.
 *
 * `evaluations[]` is a record of ONE invocation's observed tree state. It is not a reproduction recipe, and two equal
 * observations are two samples, not a proof. See .harness/docs/schemas.md.
 */
const JUDGED_COMMIT_RE = /^[0-9a-f]{40}$/;
const DIGEST_12_RE = /^[0-9a-f]{12}$/;
const DIGEST_16_RE = /^[0-9a-f]{16}$/;
/** The basis vocabulary is single-valued: a second value would let a declaration be relabelled as an observation. */
const JUDGED_COMMIT_BASES = ['observed'];
/**
 * Three values, not two (adversarial correction C10): a linked worktree of THIS repository is a first-class target that
 * routinely sits at a different commit, and collapsing it into the primary checkout would hide exactly the case
 * `prepare-workspace.sh` used to create — that script is now a delegating wrapper that exits 2 and creates nothing.
 */
const JUDGED_COMMIT_SCOPES = ['primary_repo', 'linked_worktree_of_this_repo', 'unrelated_tree'];
const EVALUATIONS_MAX_ENTRIES = 10_000;
const EVALUATIONS_LOCKFILE = 'package-lock.json';

/**
 * P2a — environment provenance. The N5 record could not distinguish a contaminated run from a correct one because
 * `lockfile_digest` is a DECLARED value (what the lockfile says) and the string `node_modules` appeared 0 times in any
 * record. These arrays are the vocabulary of the OBSERVED half: what a resolver actually chose, and what npm itself
 * declares it installed. Neither is a containment guarantee and neither authenticates anything — see the permanent
 * same-principal limitation in AGENTS.md.
 */
const ENVIRONMENTS_MAX_ENTRIES = 10_000;
const ENVIRONMENTS_SCHEMA_VERSION = 1;
/** Operator state, not evidence: the workspace attestation is written under `state/workspaces/`. */
const WORKSPACE_ATTESTATION_SCHEMA_VERSION = 1;
/** A bounded resolver probe. Five names is enough to catch upward inheritance without paying for a full manifest. */
const RESOLVER_PROBE_CAP = 5;
const DEPENDENCY_PROVISIONING = [
  'installed_historical',
  'linked_from_primary',
  'inherited_upward',
  'present_unattested',
  'escapes_workspace',
  'absent',
  'unresolved',
];
const DEPENDENCY_PROVISIONING_BASES = ['observed', 'declared', 'unresolved'];
const NODE_MODULES_TOPOLOGY = ['real_directory', 'symlink', 'partial', 'missing'];
const NODE_MODULES_SCOPES = ['worktree_local', 'escapes_worktree', 'inherited_upward', 'none'];
const INSTALL_MODES = ['npm_ci', 'npm_install', 'none'];
const INSTALL_OUTCOMES = ['succeeded', 'failed', 'not_run'];
const INSTALLED_DIGEST_SOURCES = ['node_modules_package_lock', 'tree_walk'];

/**
 * The installed TREE, as this local program can see it, at one of two explicitly-named tiers.
 *
 * `installed_state_digest` is npm's own ACCOUNT of the tree (`node_modules/.package-lock.json`) and is labelled
 * `declared_by_npm` everywhere it appears. It cannot see an in-place content change, so it is not, and is never
 * described as, a verification of the bytes. `installed_tree_fingerprint` is a separate, differently-named,
 * differently-labelled observation THIS program makes by walking the directory.
 *
 * MEASURED COST on this repository's real dependency tree (staged into a throwaway root, `npm ci` from the project's
 * own lockfile under npm 12.0.1: 53 398 walk entries, 856 MB, cold install 7 272 ms):
 *
 *   tier        cost         detects                                                  cannot detect
 *   ---------   ----------   -------------------------------------------------------   ------------------------------------
 *   metadata    213-246 ms   add / remove / rename; a change of a file's SIZE,           a content write that leaves size,
 *                           mtime, ctime and mode ALL identical — and ctime is           mtime, ctime and mode unchanged,
 *                           unforgeable, so no ordinary process can do that             which userspace cannot do; what it
 *                           (measured: Node's `utimesSync` cannot even restore           still cannot rule out is a rollback
 *                           the sub-millisecond mtime ext4 records)                    of the whole tree to a previously
 *                                                                                       recorded state
 *   content     3 039-3 121  any change to the path set, a symlink target, or a        nothing this program can read; and
 *               ms            file's CONTENT, hashed byte for byte, with no            `file:` DIRECTORY deps, which install
 *                           dependence on any filesystem timestamp semantics at all     as symlinks, record the LINK not the
 *                                                                                       target's bytes
 *
 * Both are strictly stronger than `installed_state_digest`, and both are still not a containment guarantee: see
 * `TREE_FINGERPRINT_STANDING_LIMIT`.
 */
const TREE_FINGERPRINT_TIERS = ['metadata', 'content'];
const TREE_FINGERPRINT_DEFAULT_TIER = 'metadata';
/** What each tier is, and what it is NOT — the label travels into the record and into the docs. */
const TREE_FINGERPRINT_LIMITS = {
  metadata:
    'metadata tier: path + type + size + mtime + ctime + mode per entry, read with lstat. Detects add, remove, rename, and any change of a file size, mtime, ctime or permission bit; ctime is unforgeable, so an ordinary process cannot write content and leave it invisible. CANNOT detect a content write that leaves all four identical (not achievable from userspace: measured, Node utimesSync cannot even restore the sub-millisecond mtime ext4 records), and it cannot rule out a rollback of the whole tree to a previously recorded state.',
  content:
    'content tier: path + type + SHA-256 of every byte per entry, hashed directly. Detects any change to the path set, a symlink target or a file content, with no dependence on any filesystem timestamp semantics at all. CANNOT detect a change invisible to this local program, and a file: DIRECTORY dependency installs as a SYMLINK, so the digest records the link target, not the target directory bytes.',
};
const TREE_FINGERPRINT_STANDING_LIMIT =
  'observed by this local program walking a directory: a worktree is not a security boundary, and a fingerprint is not proof the tree stayed fixed between two walks';
/**
 * The installed-tree walk's EXCLUSION set — explicit, bounded, and part of what the digest means.
 *
 * MEASURED, twice. (1) The exact content-tier reproducibility measured at 21/21 independent cold installs is an
 * INSTALL-ONLY property, and it does not survive a gate run: the walk root is `<workspace>/node_modules`, and inside a
 * real checkout a gate run creates `node_modules/.vite/vitest` (the UI test run) and `node_modules/.cache/wrangler`
 * (`server build`). (2) The consequence was not a slower measurement but a contradiction: a workspace that had run the
 * gate once was REFUSED on the next `prepare` with `installed_tree_fingerprint_changed`, so repeated evaluation and
 * workspace reuse were MUTUALLY EXCLUSIVE — a prepared historical workspace could be measured exactly once.
 *
 * The exclusion is the explicit alternative to the alternative. It is not silent and it is not free:
 *   * it is exactly the two MEASURED paths — not a prefix list, not a pattern, not "anything that looks like a cache";
 *   * it is RECORDED in the attestation, in the environment record and in the fingerprint's own limitation string;
 *   * its cost is stated in those strings: every byte under an excluded path is UNATTESTED for the lifetime of that
 *     workspace, and neither detected nor claimed to be;
 *   * a tool that writes its cache anywhere else is NOT excluded, and is caught (a rebuild), not silently ignored.
 * A silent exclusion would be a content-pin claim this program cannot support, so the set is part of the digest's
 * definition rather than an implementation detail of it.
 */
const INSTALLED_TREE_EXCLUSIONS = {
  version: 1,
  // Relative to the walk root `<workspace>/node_modules`. Matched as an EXACT entry name or a directory prefix, never
  // as a substring, so a package named `foo.cache` or `vite-utils` keeps being attested.
  paths: ['.vite', '.cache'],
  source:
    'measured: .vite/vitest is created by the UI test run and .cache/wrangler by `server build`, both inside <workspace>/node_modules',
};
const INSTALLED_TREE_EXCLUSION_RE = new RegExp(
  `^(?:${INSTALLED_TREE_EXCLUSIONS.paths.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:/|$)`,
);
const INSTALLED_TREE_EXCLUSIONS_TEXT = `EXCLUDED from the walk (set version ${INSTALLED_TREE_EXCLUSIONS.version}, explicit and recorded): ${INSTALLED_TREE_EXCLUSIONS.paths.join(', ')} under <workspace>/node_modules — ${INSTALLED_TREE_EXCLUSIONS.source}. The SAME set is applied to the installed-entry COUNT, because that count is itself a reuse condition: a count that moved because a gate run wrote a cache would refuse a workspace this digest considers unchanged. The COST is that every byte under those paths is UNATTESTED: a change there is invisible to this fingerprint and is neither detected nor claimed to be. Any other cache path is NOT excluded and still forces a rebuild`;
/**
 * npm is the only manager this project needs: one repository, one lockfile (`package-lock.json`), one manager on PATH,
 * and no commit in this repository's history that used another. pnpm/yarn/bun would add a second resolution
 * algorithm, a second lockfile format, a second install strategy and a second silent-divergence path, none of it
 * tested by any evidence in hand. The `packageManager` field is still RECORDED as a fact about the judged commit, so a
 * future commit that declares another manager is visible in the record and the decision gets made then, with evidence.
 */
const PACKAGE_MANAGER_NAMES = ['npm'];
const WORKSPACE_ROOT_SOURCES = ['env_override', 'xdg_cache_home', 'home_cache'];
const WORKSPACE_STATES = ['preparing', 'usable', 'unusable'];
const WORKSPACE_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/**
 * Which environment the gate child process gets. `sanitised` — the default for EVERY run, historical or not — is the
 * environment this harness CONSTRUCTS and then digests into the record. `inherited` hands the gate the operator's shell
 * wholesale; it is recorded as a deviation, because it re-opens exactly the `NODE_PATH` hole C11 exists to close.
 */
const GATE_ENV_POLICIES = ['sanitised', 'inherited'];
const GATE_ENV_DEFAULT_POLICY = 'sanitised';

/**
 * ONE REFUSAL FOR AN UNRECOGNISED `--gate-env`, ON EVERY COMMAND THAT TAKES THE FLAG.
 *
 * `census` refused an unrecognised policy by name while `evaluate` and `regress` silently fell back to `sanitised` and
 * `workspace prepare` accepted the flag without ever reading it. The fallback is the SAFE direction — the measurement was
 * never weakened, so this was never a false PASS — and it is still the defect the whole flag change exists to kill: a
 * record that cannot distinguish a deliberate policy from a misspelled one does not attest the environment it attests,
 * and a documented exit code (`2`, "a refusal before anything was measured") that is not honoured is precisely the "the
 * harness said it did X and it did not" bug. `EVALUATE_EXIT_BASIS` already PROMISED this refusal on `evaluate`; the code
 * did not keep the promise, so the fix belongs here and not in the prose.
 *
 * The reason below is the ONLY one: `census`, `evaluate`, `regress` and `workspace prepare` all print it verbatim, so two
 * commands cannot drift apart on why they refuse, because there is one sentence to drift.
 */
const GATE_ENV_REFUSAL_NAME = 'unknown_gate_env_policy';
const GATE_ENV_REFUSAL_BASIS =
  'An unrecognised --gate-env is refused BY NAME rather than coerced to the default. Coercing it is the SAFE direction, so it was never a weakened measurement and never a false pass — and it is still a defect: a run record that cannot distinguish a deliberate policy from a misspelled one does not attest the environment it claims to attest, and a documented exit code that is not honoured is the "the harness said it did X and it did not" bug this flag boundary exists to kill. Omit the flag to take the default.';

/**
 * The one refusal, as DATA. Returned rather than printed, so each caller routes it through its OWN refusal channel
 * (`fail()`, `workspaceFail()`, the census printer) and still prints identical words.
 */
function unknownGateEnvPolicyRefusal(raw) {
  return {
    name: GATE_ENV_REFUSAL_NAME,
    reason: `--gate-env=${raw} is not one of ${GATE_ENV_POLICIES.join(' | ')}. This command does not fall back to a default for an unrecognised policy: a silent fallback would make a deliberate policy indistinguishable from a misspelled one in the very record that is supposed to attest the environment. Omit the flag for the default.`,
    lines: [
      `policies accepted: ${GATE_ENV_POLICIES.join(', ')}`,
      `default when the flag is absent: ${GATE_ENV_DEFAULT_POLICY}`,
      `refused because: ${GATE_ENV_REFUSAL_BASIS}`,
    ],
  };
}

/**
 * The one check, called at the flag boundary of every command that declares `--gate-env` — before a run stream, a
 * workspace, an installation or a ledger row exists. `onRefuse` is the caller's own refusal channel and always receives
 * `unknownGateEnvPolicyRefusal(raw)`, so no command can phrase this differently from another.
 */
function assertGateEnvFlagValue(flags, onRefuse) {
  const raw = typeof flags['gate-env'] === 'string' ? flags['gate-env'] : null;

  if (raw !== null && !GATE_ENV_POLICIES.includes(raw)) {
    onRefuse(unknownGateEnvPolicyRefusal(raw));
  }

  return raw;
}

/**
 * THE SAME TREATMENT FOR `--fingerprint`, AND IT WAS MISSING ON `regress`. `census` refused an unrecognised tier at the
 * boundary and `workspace prepare` refuses it by name too, but `regress` forwarded the value into its two children and
 * the failure arrived late, inside workspace preparation, in the WORKSPACE exit set — a pre-evaluation event rather
 * than the command-local usage refusal the operator's own command line earned. It fails closed and it names the tier, so
 * this is not a false measurement; it is the same "the documented exit code is not the one you get" defect, and it is
 * closed with the same one-payload approach.
 */
const FINGERPRINT_REFUSAL_NAME = 'unknown_fingerprint_tier';

function unknownFingerprintTierRefusal(raw) {
  return {
    name: FINGERPRINT_REFUSAL_NAME,
    reason: `--fingerprint=${raw} is not one of ${TREE_FINGERPRINT_TIERS.join(' | ')}. The tier is part of the reuse key, so an unrecognised one cannot be verified under any rule, and it is refused HERE rather than deep inside workspace preparation where it reads as a measurement failure rather than as a typo.`,
    lines: [
      `tiers accepted: ${TREE_FINGERPRINT_TIERS.join(', ')}`,
      `default when the flag is absent: ${TREE_FINGERPRINT_DEFAULT_TIER}`,
    ],
  };
}

/** The `--fingerprint` half of `assertGateEnvFlagValue`, on the same terms and for the same reason. */
function assertFingerprintFlagValue(flags, onRefuse) {
  const raw = typeof flags.fingerprint === 'string' ? flags.fingerprint : null;

  if (raw !== null && !TREE_FINGERPRINT_TIERS.includes(raw)) {
    onRefuse(unknownFingerprintTierRefusal(raw));
  }

  return raw;
}
const WORKSPACE_DEFAULT_INSTANCE = 'default';
const WORKSPACE_ROOT_RELATIVE = 'task-board-harness/worktrees';
const WORKSPACES_DIR = join(STATE_DIR, 'workspaces');
/** P1: `harness workspace` publishes a COMMAND-LOCAL exit set. It is never an evaluate exit code. */
const WORKSPACE_EXIT_USAGE = 2;
const WORKSPACE_EXIT_ENVIRONMENT = 5;

/**
 * A6 — npm's config-FILE channel.
 *
 * The `sanitised` child environment drops every `npm_config_*` / `NPM_CONFIG_*` VARIABLE and `NPM_CONFIG_USERCONFIG`
 * with them. What it does NOT close is npm's re-derivation of `$HOME/.npmrc` from `HOME`, which passes through
 * untouched: a hostile user npmrc setting `registry=http://evil…` reached the gate under `gate_env_policy:
 * "sanitised"` with `deviation: null` and no field describing any npmrc at all. The record was therefore describing an
 * environment it had not fully observed.
 *
 * This is a RECORDED LIMIT, not a solved problem. Closing the file channel means refusing to run npm at all for an
 * operator who has an npmrc, which is a different product decision. What is fixed here is the observability half: the
 * digests of the effective user and global config files travel in every environment record with an honest basis
 * string, and the docs say plainly that the channel is open.
 */
const NPM_CONFIG_FILES_BASIS =
  'digests of the npm config FILES npm re-derives from HOME and the global prefix. The sanitised environment drops every npm_config_*/NPM_CONFIG_* VARIABLE (NPM_CONFIG_USERCONFIG included), but a config FILE is a channel that environment does not close: this is a RECORDED LIMIT, not a solved problem. Values are never recorded — only a digest and a path.';
/** Bounded candidate set for the GLOBAL npmrc. `npm config get globalconfig` is deliberately not spawned: a probe
 *  that can itself be redirected by a hostile environment is a worse source than a fixed, stated candidate list. */
const NPM_GLOBAL_CONFIG_CANDIDATES = ['/etc/npmrc', '/usr/local/etc/npmrc', '/usr/etc/npmrc'];

/**
 * What the build-state observation detects and what it does not, in the field's own words.
 *
 * DETECTS: the PRESENCE, ABSENCE and BYTES of the build outputs the gate's resolved scripts depend on — each planned
 * package's declared entrypoint directories, hashed at the content tier — and the set of GITIGNORED path NAMES git
 * reports for this worktree. That second half is the one observation that covers the whole class (this repository's
 * `shared/dist/`, `server/dist/`, `ui/dist/`, `ui/.angular/` and `ui/public/themes/manifest.json`) without a field per
 * artefact, and every one of them is invisible to `status_hash` because `git status` without `--ignored` does not print
 * them.
 *
 * DOES NOT DETECT, and is never described as detecting: a change to build output OUTSIDE the planned entrypoint
 * directories; a build product the commit's own `.gitignore` does not list, so git never reports it; any change to the
 * BUILD that produced these bytes (two builds that emit identical bytes are indistinguishable); and anything at all
 * about the primary checkout, which is never read. This is an OBSERVATION OF BYTES, not a content pin.
 *
 * SECRETS: a gitignored SECRETS file (this repository's `server/.dev.vars`) appears in the ignored-path NAMES because
 * git names it. Its contents are never opened, hashed, digested, printed or recorded; only the declared build-output
 * directories are ever read as bytes.
 */
const BUILD_STATE_LIMITATION =
  "observed by this local program inside the judged worktree: a digest over the build outputs the gate's resolved scripts depend on (each planned package's declared entrypoint directories, hashed byte for byte) plus the NAMES of the paths git reports as ignored for that worktree. It is an OBSERVATION OF BYTES, NOT A CONTENT PIN: it does not say which toolchain produced them, and two builds that emit identical bytes are indistinguishable. It CANNOT detect a build product outside the planned entrypoint directories, a build product the commit's own .gitignore does not list, any change to the build that produced the bytes, or anything at all about the primary checkout. Ignored path NAMES are recorded and nothing else about them: a gitignored secrets file such as server/.dev.vars is named because git names it, and its contents are never opened, hashed, digested or recorded. A worktree is not a security boundary, and a build-state digest is not proof the outputs stayed fixed between two observations";
/** What `build_state.observed: false` means: a failure to observe, never an absence of build output. */
const BUILD_STATE_UNOBSERVED_BASIS =
  'this build state could not be OBSERVED: the walk over the planned build outputs failed, or the ignored-path listing could not be read. "Not observed" is an absence of evidence, never evidence of absence, and the reuse check fails closed on it';
const BUILD_MODES = ['derived', 'declared', 'disabled', 'not_applicable'];
const BUILD_OUTCOMES = ['succeeded', 'failed', 'not_run', 'disabled', 'unavailable'];
const BUILD_MAX_WORKSPACE_PACKAGES = 32;
const BUILD_STATE_MAX_ENTRIES = 5000;
const BUILD_STATE_MAX_DEPTH = 8;
const BUILD_STATE_MAX_IGNORED_PATHS = WORKSPACE_FILE_CAP;
const BUILD_COMMAND_MAX_CHARS = 400;
const BUILD_OUTPUT_TAIL_LINES = 20;
const BUILD_OUTPUT_TAIL_MAX_CHARS = 2000;
/**
 * Where the build command comes from, stated in the record and never implied. A command read from the CONTRACT would
 * be a declaration the historical commit never made; a command read from the PRIMARY CHECKOUT would be a different
 * string from the one the commit declared. Only the judged commit's own manifests are a source.
 */
const BUILD_COMMAND_BASIS =
  "read from the JUDGED COMMIT'S OWN manifests (git show <commit>:<workspace>/package.json) inside this repository, never from the task contract and never from the primary checkout: a historical commit's `build` script is a different string at each commit, so any other source would measure a tree the commit never declared";
/** What `historical_build_command` is when `--build-command` supplied it: a DECLARATION, recorded and never silent. */
const BUILD_COMMAND_DECLARED_BASIS =
  'SUPPLIED BY THE OPERATOR as --build-command: a DECLARED input, recorded verbatim and never silently substituted. This harness spawns argv directly and never through a shell, so the string is an argv, not a shell line';
/**
 * A build EXECUTES HISTORICAL CODE. The install runs with `HUSKY=0` so npm's only lifecycle script is neutralised; a
 * build has no equivalent neutraliser and is a strictly LARGER class of script. Whether that code did anything is not
 * observable from here, so the value is permanently `null` and NEVER `true`.
 */
const BUILD_SCRIPT_EXECUTION_BASIS =
  "unknown and unrecorded as a fact, permanently null: a build step EXECUTES the historical commit's own `build` string, which may run any program that string names, and this harness observes no individual script, subprocess, network call or side effect. Unlike the install there is NO neutraliser — no --ignore-scripts equivalent neutralises an explicitly invoked `npm run build` — so this is a strictly LARGER class of script than the install's. A worktree is not a security boundary: that code ran with the operator's privileges on the operator's filesystem";

/**
 * Execution-state ledger — durable task state, NOT memory and NOT telemetry.
 * One file per run: `.harness/state/ledgers/<run_id>.json`. The supported evaluator path is the only writer of
 * verification evidence and of the `verified` / `failed` statuses; this is not an at-rest writer property.
 */
const LEDGER_DIR = join(STATE_DIR, 'ledgers');
const LEDGER_VERSION = 1;
/**
 * Lifecycle (Strict acceptance semantics model, implemented in Structural behavior):
 *   pending → in_progress → verification_pending → verified
 * with `failed` (verification ran and failed), `blocked` (cannot proceed legitimately),
 * `interrupted` (stopped mid-flight, resumable) and `aborted` (deliberately abandoned).
 * Only `verified` and `failed` are evidence-bearing; the rest are recorded state.
 */
const LEDGER_STATUSES = [
  'pending',
  'in_progress',
  'verification_pending',
  'verified',
  'failed',
  'blocked',
  'interrupted',
  'aborted',
];
/** Statuses only the evaluator may set, and only after running the gate. */
const EVALUATOR_ONLY_STATUSES = ['verified', 'failed'];
/** npm `--workspace` argument → directory inside the repository. */
const WORKSPACE_DIRS = {
  '@task-board/ui': 'ui',
  '@task-board/server': 'server',
  '@task-board/shared': 'shared',
  shared: 'shared',
  ui: 'ui',
  server: 'server',
};

function isNoisePath(path) {
  return NOISE_UNTRACKED.some(
    (noise) =>
      path === noise || path.startsWith(`${noise}/`) || path.endsWith(`/${noise}`) || path.includes(`/${noise}/`),
  );
}

/**
 * Deterministic gate definitions. Fixed commands only — task files can select a gate name but can
 * never inject a command string. Steps stop at the first failure (fail fast).
 */
const GATES = {
  'check:fast': [
    { step: 'lint', command: 'npm', args: ['run', 'lint'], category: 'lint_failure' },
    {
      step: 'typecheck:shared+server',
      command: 'npm',
      args: ['run', 'typecheck'],
      category: 'typecheck_failure',
    },
    {
      step: 'typecheck:ui',
      command: 'npm',
      args: ['run', 'typecheck', '--workspace=@task-board/ui'],
      category: 'typecheck_failure',
    },
  ],
  check: [
    { step: 'lint', command: 'npm', args: ['run', 'lint'], category: 'lint_failure' },
    {
      step: 'typecheck:shared+server',
      command: 'npm',
      args: ['run', 'typecheck'],
      category: 'typecheck_failure',
    },
    {
      step: 'typecheck:ui',
      command: 'npm',
      args: ['run', 'typecheck', '--workspace=@task-board/ui'],
      category: 'typecheck_failure',
    },
    {
      step: 'test:server',
      command: 'npm',
      args: ['test', '--workspace=@task-board/server'],
      category: 'test_failure',
    },
    {
      step: 'test:ui',
      command: 'npm',
      args: ['test', '--workspace=@task-board/ui'],
      category: 'test_failure',
    },
  ],
  'check:full': [
    { step: 'lint', command: 'npm', args: ['run', 'lint'], category: 'lint_failure' },
    {
      step: 'typecheck:shared+server',
      command: 'npm',
      args: ['run', 'typecheck'],
      category: 'typecheck_failure',
    },
    {
      step: 'typecheck:ui',
      command: 'npm',
      args: ['run', 'typecheck', '--workspace=@task-board/ui'],
      category: 'typecheck_failure',
    },
    {
      step: 'test:server',
      command: 'npm',
      args: ['test', '--workspace=@task-board/server'],
      category: 'test_failure',
    },
    {
      step: 'test:ui',
      command: 'npm',
      args: ['test', '--workspace=@task-board/ui'],
      category: 'test_failure',
    },
    {
      step: 'build:shared',
      command: 'npm',
      args: ['run', 'build', '--workspace=shared'],
      category: 'environment',
    },
    {
      step: 'build:server',
      command: 'npm',
      args: ['run', 'build', '--workspace=@task-board/server'],
      category: 'environment',
    },
    {
      step: 'build:ui',
      command: 'npm',
      args: ['run', 'build', '--workspace=@task-board/ui'],
      category: 'environment',
    },
  ],
  // A standalone benchmark gate is additive. The canonical gates above run this repository's own npm scripts; a benchmark
  // mini-project is not this repository, so `harness evaluate` could
  // not otherwise execute its mechanical gate at all (gate steps must be npm scripts inside the evaluated
  // workspace — see gateStepScript). This entry adds a gate; it changes no existing gate, threshold or
  // fail-closed rule. Rollback: delete this object.
  benchmark: [{ step: 'benchmark-suite', command: 'npm', args: ['test'], category: 'test_failure' }],
};

const DEFAULT_GATE = 'check';

/** Failure taxonomy — descriptive categories, not error messages. Mirrors .harness/docs/failure-taxonomy.md. */
const TAXONOMY = [
  ['implementation', 'Change was produced but behaves incorrectly / incomplete against acceptance.'],
  ['wrong_file', 'Edits landed in the wrong place or an unrelated file was modified.'],
  ['stale_state', 'The agent acted on a version of a file or schema that had already changed.'],
  ['tool_error', 'A tool invocation itself failed or returned malformed output.'],
  ['test_failure', 'The canonical gate failed at a test step.'],
  ['typecheck_failure', 'The canonical gate failed at a typecheck step.'],
  ['lint_failure', 'The canonical gate failed at the lint step.'],
  ['edit_cascade', 'Repeated failed edits; the agent could not recover the edit.'],
  ['redundant_work', 'Work was repeated that was already done (re-read / re-run).'],
  ['context_exhaustion', 'Context window limits forced truncation or a restart.'],
  ['budget', 'Run ended because a turn/tool/time budget was hit.'],
  ['premature_completion', 'The agent stopped and claimed completion before the work was done.'],
  ['environment', 'Failure caused by the local environment (docker, wrangler, node, network).'],
  ['unclassified', 'Failure observed but not yet categorised.'],
];

const TAXONOMY_IDS = TAXONOMY.map(([id]) => id);

const REQUIRED_TASK_FIELDS = ['id', 'title', 'category', 'source_commit', 'acceptance', 'workspace'];

const GATE_DEFINITION_SHA = createHash('sha256').update(JSON.stringify(GATES)).digest('hex').slice(0, 16);

function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);

  // ---- PER-COMMAND HELP, short-circuited BEFORE the switch and therefore before any `parseFlags()` call.
  //
  // `--help` / `-h` is a MODE OF INVOCATION, not a flag request, and the difference is load-bearing rather than
  // cosmetic. `COMMAND_FLAG_ALLOWLIST` refuses an unrecognised flag BY NAME at `UNKNOWN_FLAG_EXIT` so that
  // `evaluate --acceptence=pass` cannot be read as a granted capability. An allowlist entry for `help` would make
  // the same mistake in the other direction: a help screen reachable as an ordinary flag, on code paths that never
  // meant it, and a flag that could then be accepted as data. So there is no allowlist entry, no boolean-flag
  // entry, and `UNKNOWN_FLAG_EXIT` is untouched — every OTHER unknown flag is still refused by name.
  //
  // `harness help <command>` is the same screen reached the other way round. `harness help` with no command still
  // falls through to the `default` arm, which prints the top-level help and exits 0 exactly as it did before.
  if (command === 'help' && rest.length > 0) {
    const forwarded = printCommandHelp(rest[0], rest.slice(1));

    if (forwarded !== null) return forwarded;
  }
  //
  // FIX B1 — ASKING FOR HELP NEVER RUNS THE COMMAND. `printCommandHelp` returns `null` for a command that has no
  // per-command screen, and that `null` used to be read as "decline, and let the dispatch switch run it anyway". The
  // consequence was the worst kind: a specialist asking a command how it works LAUNCHED the command. `self-test
  // --help` ran the entire invariant suite, `list --help` and `taxonomy --help` silently ignored the flag, and
  // `show --help` consumed `--help` as a task id and failed. A help request is a MODE OF INVOCATION, and a mode of
  // invocation is not a run.
  //
  // So a command with no per-command screen now prints the TOP-LEVEL screen and exits 0, and the dispatch switch is
  // never reached. The invariant is unconditional: NO `--help`/`-h` request can reach a command's body, so none of
  // the nine no-screen commands can be started, and none of them can write, by asking. The top-level screen is
  // rendered by the SAME `printHelp()` the `default` arm calls, so `harness list --help` and `harness --help` are
  // byte-identical — the screen did not gain a word for this.
  if (rest.includes('--help') || rest.includes('-h')) {
    const forwarded = printCommandHelp(command, rest);

    if (forwarded !== null) return forwarded;

    return printTopLevelHelpForHelpToken(rest);
  }

  switch (command) {
    case 'list':
      return cmdList();
    case 'validate':
      return cmdValidate(rest);
    case 'show':
      return cmdShow(rest[0]);
    case 'taxonomy':
      return cmdTaxonomy();
    case 'evaluate':
      return cmdEvaluate(parseFlags(rest, { command: 'evaluate' }));
    case 'workspace':
      return cmdWorkspace(rest);
    case 'regress':
      return cmdRegress(parseFlags(rest, { command: 'regress' }));
    // A history census is its own QUESTION (a range, not a pair) with its own artifact vocabulary and its own
    // command-local exit set — but NOT its own measurement: every row goes through the same `regressRunSide`, the same
    // `workspace prepare`, the same `evaluate --step` and the same trial-log writer. One implementation, two questions.
    case 'census':
      return cmdCensus(parseFlags(rest, { command: 'census' }));
    case 'report':
      return cmdReport(parseFlags(rest, { command: 'report' }));
    case 'modes':
      return cmdModes(parseFlags(rest, { command: 'modes' }));
    case 'predicates':
      return cmdPredicates(parseFlags(rest, { command: 'predicates' }));
    case 'handoff':
      return cmdHandoff(parseFlags(rest, { command: 'handoff' }));
    // `contract init` derives a VALID contract from the current HEAD. It exists because `.harness/state/tasks/` ships
    // empty and there was no create command at all, which made every gate-bearing command unreachable for the primary
    // consumer of this harness: not a missing feature but a locked door in front of the features. See change 5, and
    // the seed caveat on the derived `acceptance` in `cmdContractInit`.
    case 'contract':
      return cmdContract(rest);
    case 'self-test':
      return runSelfTest({
        runToken: (value) => RUN_TOKEN_RE.test(value),
        classifyGateLog,
        classifyReportPopulation,
        createGateLogWriter,
        createWriter,
        initializeLedger,
        inspectLedgerInventory: (ledgerDir) => inspectLedgerInventory(ledgerDir),
        mutateLedger,
        parseStrictJson,
        resolveControlPath,
        resolveExternalOutputPath,
        validateOperationalLedger,
        writeNewFileExclusive,
        // ORDER-AWARE SCHEDULING and the PER-STEP MODE. Injected on the same terms as everything above: the I26 group
        // asserts the REAL schedule and the REAL step-scope resolution, not a re-implementation of either.
        regressInterleavedSchedule,
        regressExecutionOrder,
        regressPositionConditionalStates,
        REGRESS_ORDER_SCHEME_SINGLE,
        REGRESS_ORDER_SCHEME_INTERLEAVED,
        REGRESS_ORDER_LEGACY,
        REGRESS_ORDER_BASIS,
        REGRESS_ORDER_RESIDUAL,
        resolveStepScope,
        resolveStepFlag,
        assertGateStepExists,
        STEP_SCOPE_STATES,
        STEP_SCOPE_UNDEFINED_BASIS,
        STEP_SCOPE_FAIL_FAST_BASIS,
        STEP_SCOPE_LEDGER_EFFECT,
        // The AGENT-FIRST surface: the per-command flag allowlist, the verdict scope/value derivations, the `evaluate`
        // exit table, and the prior-observation summariser. Injected on the same terms as everything else, so the I28
        // group asserts the REAL derivations and the REAL allowlist rather than a restatement of them.
        COMMAND_FLAG_ALLOWLIST,
        COMMAND_POSITIONAL_POLICY,
        // I3: the per-command help. Injected on the same terms as everything else, so the I33 group asserts the REAL
        // bodies, the REAL budgets and the REAL command list rather than a restatement of them.
        COMMAND_HELP,
        COMMAND_HELP_BUDGET,
        commandHelpBody,
        CONTRACTLESS_TASK,
        CONTRACT_SEED_BASIS,
        EVALUATE_EXIT_BASIS,
        EVALUATE_EXIT_TABLE,
        PRIOR_OBSERVATIONS_BASIS,
        PRIOR_OBSERVATIONS_CAVEAT,
        PRIOR_OBSERVATIONS_CAVEAT_BASIS,
        PRIOR_OBSERVATIONS_CAVEAT_CODE,
        PRIOR_OBSERVATIONS_MAX_STREAMS,
        BARE_VALUE_FLAG_BASIS,
        COMMAND_BOOLEAN_FLAGS,
        COMMAND_VALUE_FLAGS,
        UNKNOWN_FLAG_BASIS,
        UNKNOWN_FLAG_EXIT,
        VERDICT_SCHEMA,
        VERDICT_SCHEMA_NEUTRALISED,
        VERDICT_SCOPES,
        VERDICT_VALUES,
        CANONICAL_GATE,
        CANONICAL_STEP_COUNT,
        MACHINE_SURFACE_BASIS,
        assertKnownFlags,
        booleanFlagsFor,
        evaluateVerdictScope,
        evaluateVerdictValue,
        evaluatedGateExitCode,
        flagAllowlistFor,
        neutraliseVerdictToken,
        priorObservationKey,
        summariseExitCodes,
        valueFlagsFor,
        verdictEnvironment,
        // Commit-bound evaluation records. Injected (not imported) so the self-test module stays free of a cycle with
        // this module and can exercise the real implementations.
        appendEvaluation,
        buildEvaluationEntry,
        canonicalJson,
        contractDigest,
        ledgerStateQuality,
        normalizeCommitSha,
        observeJudgedTree,
        resolveJudgedScope,
        // P1 + P2a. Injected (not imported) for the same reason: the self-test module exercises the real
        // implementations without a cycle with this module.
        ancestorNodeModulesRefusal,
        appendEnvironment,
        assertHistoricalProject,
        assertNoSymlinkedNodeModules,
        assertWorkspaceRootRefusals,
        // A5: the npm-cache placement refusal, the same class as the worktree root's, driven directly.
        assertNpmCacheRefusal,
        buildEnvironmentEntry,
        // A4: the gate-output fence, driven directly so "a forged line cannot be read as a harness field" is a fact
        // about the function and not only about one run's stdout.
        gateOutputFence,
        // A1/A2/A3/A6/P2/P3: the values and helpers the new assertions read.
        LEDGER_WRITE_CONFLICT,
        LEDGER_SELECTION_DISCLOSURE,
        NPM_CONFIG_FILES_BASIS,
        newestEnvironmentRecord,
        observeNpmConfigFiles,
        classifyProvisioning,
        computeWorkspaceKey,
        constructChildEnv,
        detectPrimaryCheckoutChange,
        envFacts,
        isContainedBy,
        judgeCommitProbeNames,
        npmSupportedLockfileVersions,
        observeInstalledState,
        observeNode,
        observePrimaryGitConfig,
        observeResolverProbe,
        observeResolverNegativeControl,
        observeInstalledTreeFingerprint,
        classifyResolverProbe,
        resolverProbeProblems,
        historicalInstallScriptFacts,
        // P0: the historical build step, the build-state observation and the declared walk exclusions, driven directly
        // so "the build state is re-verified on every reuse and fails closed" is a fact about the functions.
        BUILD_COMMAND_BASIS,
        BUILD_COMMAND_DECLARED_BASIS,
        BUILD_MODES,
        BUILD_OUTCOMES,
        BUILD_PLAN_SELECTION_RULE,
        BUILD_SCRIPT_EXECUTION_BASIS,
        BUILD_STATE_LIMITATION,
        BUILD_STATE_NOT_APPLICABLE_BASIS,
        BUILD_STATE_UNOBSERVED_BASIS,
        INSTALLED_TREE_EXCLUSIONS,
        INSTALLED_TREE_EXCLUSIONS_TEXT,
        TREE_FINGERPRINT_TIERS,
        TREE_FINGERPRINT_LIMITS,
        TREE_FINGERPRINT_STANDING_LIMIT,
        RESOLVER_NEGATIVE_CONTROL,
        GATE_ENV_POLICIES,
        GATE_ENV_DEFAULT_POLICY,
        treeFingerprintTierOrFail,
        packageManagerRecord,
        declaredEntrypoints,
        declaredPathValue,
        declaredExportsValue,
        undeterminedEntrypointFields,
        PACKAGE_PATH_FIELDS,
        countTreeEntries,
        BUILD_PLAN_UNDETERMINED_BASIS,
        BUILD_ESCAPE_BASIS,
        BUILD_ESCAPE_UNOBSERVED,
        beginBuildEscapeObservation,
        finishBuildEscapeObservation,
        buildEscapeRoots,
        boundedDirectoryNames,
        WORKSPACE_STATES,
        workspaceAttestationStateIsKnown,
        historicalBuildPlanForCommit,
        localWorkspaceSpec,
        observeBuildState,
        observeIgnoredPaths,
        parseDeclaredBuildCommand,
        runHistoricalBuild,
        verifyReusableBuildState,
        probeResolvesInsideWorkspace,
        resolveWorkspaceRoot,
        verifyReusableWorkspace,
        workspaceNodeModulesPaths,
        // P3 + P4. The comparison is a pure decision over plain facts, so the self-test drives every boundary of the
        // four-state classifier and the pair decision without a repository, a gate, or a network.
        REGRESS_ENVIRONMENT_FIELDS,
        REGRESS_EXIT_CLEANUP_FAILED,
        REGRESS_EXIT_FINDING,
        REGRESS_EXIT_FIVE_BASIS,
        REGRESS_EXIT_INCONCLUSIVE,
        REGRESS_EXIT_NO_FINDING,
        REGRESS_EXIT_PRECEDENCE,
        REGRESS_EXIT_RULE,
        REGRESS_EXIT_SIDE_ERROR,
        REGRESS_EXIT_USAGE,
        REGRESS_GATE_EXECUTION_LIMIT,
        REGRESS_INVOCATION_LENGTH,
        REGRESS_LIMITATIONS,
        REGRESS_RUN_ORIGIN_KIND,
        // P1: repeated evaluation. The classification, the exact bound, the exchangeability line, the anti-conservative
        // detector and the non-resolving note are all driven directly here, so every boundary of the rule is a fact
        // about the functions and not only about one real run.
        REPEAT_ANTI_CONSERVATIVE_BASIS,
        REPEAT_BOUND_METHOD_EXACT,
        REPEAT_BOUND_METHOD_ZERO,
        REPEAT_BOUND_NOT_A_LICENCE,
        REPEAT_CLASSIFICATION_RULE,
        REPEAT_CONFIDENCE,
        REPEAT_DEFAULT_TRIALS,
        REPEAT_EXCHANGEABILITY,
        REPEAT_LIMITATIONS,
        REPEAT_MAX_TRIALS,
        REPEAT_NON_RESOLVING,
        REPEAT_RULE_CONTRADICTION,
        REPEAT_RULE_IDS,
        REPEAT_RULE_UNANIMOUS,
        REPEAT_TRIALS_LOG_SCHEMA_VERSION,
        REPEAT_UNATTAINABLE_BASIS,
        REPEAT_VERDICT_BASIS,
        REPEAT_VERDICT_BASIS_TEXT,
        REPEAT_VOTE_FORBIDDEN,
        REPEAT_ANTI_CONSERVATIVE_EVIDENCE_BASIS,
        // FIX PASS B: the replay trust surface. B1 binding, B2 re-derivation, B3 chain, B6 byte bound, B8 lock.
        REPEAT_TRIALS_CHAIN_GENESIS,
        REPEAT_TRIALS_CHAIN_LIMIT,
        REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE,
        REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS,
        REPEAT_TRIALS_LOG_MAX_BYTES,
        // THE CENSUS. Injected on the same terms as everything above: the I27 group drives the REAL cascade, the REAL
        // monotonicity derivation, the REAL refusal and the REAL exit set, not a re-implementation of any of them.
        censusClassifyTransition,
        censusRegions,
        censusTransitions,
        censusCandidates,
        censusMonotonicity,
        censusRefusal,
        censusUnresolvedBlock,
        censusResolveRange,
        censusStepPackage,
        censusIsTestPath,
        censusErrorSignature,
        censusRangeBinding,
        CENSUS_CASCADE,
        CENSUS_CASCADE_IDS,
        CENSUS_STATES,
        CENSUS_HOLE_STATES,
        CENSUS_MONOTONICITY_STATES,
        CENSUS_MONOTONICITY_SCOPE,
        CENSUS_MONOTONICITY_BASIS,
        CENSUS_NO_INFORMATION_BASIS,
        CENSUS_MAX_COMMITS,
        CENSUS_MAX_COMMITS_BASIS,
        CENSUS_ERROR_MODES,
        CENSUS_CLASSIFICATION_BASIS,
        CENSUS_NOT_A_SEARCH,
        CENSUS_TRANSITION_NOT_A_CAUSE,
        CENSUS_LIMITATIONS,
        CENSUS_REFUSAL_NAMES,
        // F-1 and F-2, injected for invariant group `I30` on the same terms as everything else here: the REAL refusal
        // payload and the REAL byte floor, so the group asserts this program's behaviour rather than a re-implementation.
        GATE_ENV_REFUSAL_NAME,
        GATE_ENV_REFUSAL_BASIS,
        unknownGateEnvPolicyRefusal,
        assertGateEnvFlagValue,
        FINGERPRINT_REFUSAL_NAME,
        unknownFingerprintTierRefusal,
        assertFingerprintFlagValue,
        VERDICT_HEAD_FIELDS,
        verdictHeadByteFloor,
        CENSUS_EXIT_NO_FINDING,
        CENSUS_EXIT_FINDING,
        CENSUS_EXIT_USAGE,
        CENSUS_EXIT_COMMIT_ERROR,
        CENSUS_EXIT_UNDETERMINED,
        CENSUS_EXIT_RULE,
        CENSUS_EXIT_BASIS,
        CENSUS_REPLAY_FIDELITY,
        CENSUS_ROW_FIELDS_NOT_PERSISTED,
        censusAddedExports,
        censusForeignPackageExports,
        REPEAT_UNDECIDABLE_CAUSE_UNVERIFIED,
        REPLAY_REFUSAL_CHAIN,
        REPLAY_REFUSAL_DUPLICATE,
        REPLAY_CONCURRENCY_BASIS,
        REPLAY_REFUSAL_NAMES,
        REPLAY_REFUSAL_SESSION_BINDING,
        REPLAY_REFUSALS,
        REPLAY_TRUST_SCOPE,
        WORKSPACE_ORPHAN_SCAN_BASIS,
        compareRegressSessionBindings,
        compareRegressEnvironmentsAcrossTrials,
        regressCompareSessionBindings: compareRegressSessionBindings,
        regressReadTrialLogVerified,
        regressReplayRefusal,
        regressSessionBinding,
        regressTrialEntryDigest,
        regressTrialsLogHeadPath,
        reclaimEmptyWorkspaceKey,
        scanWorkspaceOrphans,
        verifyRegressTrialAgainstRunStream,
        withTrialVerification,
        REGRESS_TAIL_RESIDUAL_MAX,
        REGRESS_ZERO_FLIP_EXACTNESS_BASIS,
        regressAggregateDecisionSide,
        regressBinomialTailAtLeast,
        regressBoundExactness,
        regressBoundRecord,
        regressBoundTightened,
        regressFlipRateUpperBound,
        regressInvertBinomialTail,
        regressLogBinomialCoefficient,
        regressReadTrialLog,
        regressRepeatLines,
        regressResolveSession,
        regressResolveTrials,
        regressTrialRecord,
        regressTrialsLogPath,
        withRegressAggregateBasis,
        withRegressVerdictBasis,
        // P4 (the consolidated fix pass): what `status_hash` is and is not, asserted as data rather than as prose.
        REGRESS_STATUS_HASH_SCOPE,
        REGRESS_STATUS_HASH_LIMIT,
        REGRESS_SIDE_STATES,
        REGRESS_VERDICTS,
        REGRESS_VERDICT_BASIS,
        REGRESS_VERDICT_BASIS_TEXT,
        applyRegressConfirmation,
        classifyRegressSide,
        // F5: this key appeared TWICE in this object literal before the fix pass. The second was harmless (identical
        // value, last one wins) and that is exactly why it was dangerous: a duplicate key is invisible to a reader,
        // invisible to the linter here, and would silently keep a DIFFERENT value the moment the two ever diverged.
        classifyRegressTrials,
        compareRegressEnvironments,
        compareRegressGateExecution,
        compareRegressSides,
        isComparisonSourcedRun,
        observeRegressGateExecution,
        readGateScriptDefinitions,
        regressInstanceLabel,
        regressInvocationId,
        resolveRegressExitCode,
      });
    case 'ledger':
      return cmdLedger(rest);
    case 'telemetry':
      return cmdTelemetry(parseFlags(rest, { command: 'telemetry' }));
    default:
      printHelp();
      return command === 'help' || command === '--help' ? 0 : 1;
  }
}

function printHelp() {
  process.stdout.write(
    [
      'harness.mjs — deterministic evaluator for coding-task runs',
      '',
      'Commands:',
      '  list                                list task contracts in .harness/state/tasks/',
      '  validate [task-id ...]              validate contracts (all when no id given)',
      '  show <task-id>                      print one task contract',
      '  taxonomy                            print the failure taxonomy',
      '  contract init --task=<id>           derive a VALID contract from the current HEAD',
      '  evaluate --no-contract [options]    run the gate with NO contract (records contract_digest: null)',
      '  evaluate --task=<id> [options]      run the gate, write JSONL evidence',
      '  report [--out=<absolute-new-path>]  aggregate runs into a new report file',
      '',
      'historical workspace (P1; command-local exit codes 0 prepared | 2 refused | 5 environment failure —',
      'never an evaluate exit code, and never a security boundary):',
      '  workspace prepare --commit=<ref> [--instance=<label>] [--offline] [--no-install] [--keep]',
      '                         [--gate=<name>] [--force] [--npm-cache=<dir>] [--no-build] [--build-command=<argv>]',
      '    build (P0, ON by default): the workspace packages the gate needs are BUILT inside the worktree, in an order',
      "                           derived from the judged commit's OWN manifests, under the same constructed child",
      '                           environment as the install. A build failure is `unusable` with exit 5, never "usable',
      '                           but the gate will fail for an unrecorded reason". A build EXECUTES the historical',
      "                           commit's own `build` string with no neutraliser; the record says so.",
      '    --no-build             disable the build step (recorded as a deviation, never as a build that passed)',
      '    --build-command=<argv> supply the build command EXPLICITLY. Recorded as a DECLARED input, never silently;',
      '                           the harness spawns argv directly and never through a shell, so a shell',
      '                           metacharacter is refused rather than interpreted',
      '                           resolve the commit; create a detached linked worktree at a root OUTSIDE the',
      '                           repository; refuse an ancestor node_modules, a symlinked node_modules, a missing',
      '                           lockfile, an unsupported lockfileVersion and an npm cache INSIDE the repository',
      '                           BEFORE any install is spent; install',
      "                           from the commit's OWN lockfile; write the attestation; print the environment",
      '  workspace remove --commit=<ref> [--instance=<label>] [--force]',
      '  workspace prune [--stale-after=<30m|2h|7d>] [--force]   reclaim stale instances, report bytes, NON-ZERO on failure',
      '    removal target:      re-derived from workspace_key + workspace_instance under the RESOLVED worktree root; the',
      "                        attestation's recorded `directory` is CROSS-CHECKED against it, never obeyed, and a path",
      '                        outside the root is refused with or without --force',
      '    stale admin record:  a worktree directory deleted out of band is recovered by git worktree prune on the',
      '                        shipped path (prepare, remove and prune all do it) — no hand-editing required',
      '  workspace show [--commit=<ref>] [--instance=<label>] [--json]  read-only attestation inspection',
      '  workspace list                                              read-only attestation listing',
      '    --fingerprint=metadata|content      installed-tree walk tier (workspace prepare defaults to metadata,',
      '                                         evaluate defaults to none; the tier is part of the reuse key)',
      '    --gate-env=sanitised|inherited     gate child environment (default sanitised; inherited is recorded as a deviation)',
      '                                         an unrecognised value is REFUSED BY NAME, exit 2, never coerced',
      '    --accept-inherited-env=NODE_PATH   record an acceptance instead of refusing it',
      '    --accept-lockfile-version          record an out-of-set lockfileVersion instead of refusing it',
      '    --accept-pm-mismatch               record a packageManager-field conflict instead of refusing it',
      '',
      'two-commit comparison (P3/P4; command-local exit codes 0 no finding | 1 finding | 2 usage/refused |',
      '4 a side is ERROR | 5 a side is INCONCLUSIVE | 6 a removal was refused. 3 is NEVER emitted, and none of',
      'these is an evaluate exit code; regress changes no LEDGER terminal state):',
      '  regress --good=<ref> --target=<ref> --task=<id> [--gate=<name>] [--keep]',
      '         [--confirm-disagreement] [--gate-env=sanitised|inherited] [--json] [--out=<absolute-new-path>]',
      '         [--repeat=<1..299>] [--repeat-session=<token>]',
      '    Two INDEPENDENT sides: each gets its own workspace instance and its own evaluate run, so the ordinary',
      '    gate, run stream, acceptance machinery and environment record are used unchanged. Side states are',
      '    PASS | FAIL | INCONCLUSIVE | ERROR; INCONCLUSIVE is neither good nor bad and never resolves a',
      '    comparison. Verdict: no_regression | regression | already_failing | improved | cannot_compare.',
      '    By default every verdict is derived from ONE observation per side and is labelled [single observation',
      '    per side]; --repeat=N below describes the repeated mode and what it does and does not change.',
      '    --repeat=N            N INDEPENDENT trials per side (default 1, which reproduces the single-observation',
      '                         behaviour exactly: same verdicts, same exit codes, same output). Each trial is a',
      '                         complete workspace prepare + evaluate with its own instance, run id and provenance,',
      '                         and EVERY trial is preserved in the artifact and in an append-only trial log.',
      '      classification:    the CONTRADICTION rule. ANY disagreement among the trials makes the side',
      '                         INCONCLUSIVE. A VOTE IS NEVER TAKEN — not a majority, not a best-of, not the last, not',
      '                         the most common — because at a flip rate near 0.5 a majority vote is wrong exactly half',
      '                         the time for EVERY N. A trial that is ERROR or INCONCLUSIVE is never averaged away by',
      '                         the others agreeing.',
      '      the bound:          N, k, and the EXACT one-sided binomial upper limit (k=0: 1 - alpha^(1/N); k>=1: the',
      '                         Clopper-Pearson exact interval), always printed with `exchangeability: assumed,',
      '                         unverified`, with an ANTI-CONSERVATIVE warning whenever observing a disagreement',
      '                         tightened the number, and with the reason the requested bound is unattainable when it',
      '                         is. It is a bound, never a licence.',
      '      non-resolving:      the aggregate NEVER resolves a boundary. INCONCLUSIVE is named differently from',
      '                         git\'s 125 "skip" on purpose: skip means "exclude this commit and keep searching",',
      '                         which biases a search LATE in a fixed direction. Here it never skips and never names',
      '                         the other side the winner.',
      '    --repeat-session=<token>  resume an interrupted comparison: completed trials are REPLAYED from the',
      '                         append-only trial log, never re-run and never rewritten.',
      '    --confirm-disagreement  opt-in, NON-AUTHORITATIVE: re-run the failing step once on the disagreeing',
      '                         side and report both observations. It never flips a verdict and never asserts a',
      '                         direction of its own; a second observation that CONTRADICTS the first WITHDRAWS the',
      '                         direction to cannot_compare (a refusal, never a replacement).',
      "    --gate-env=…           forwarded to both sides' evaluate children and recorded; the confirmation re-run",
      '                         uses the same policy as the comparison it is confirming.',
      "    gate execution:        each side digests what its gate actually ran (resolved gate + the judged commit's",
      '                         own script definitions) and a difference is disclosed PROMINENTLY, above the routine',
      '                         environment table. It is a disclosure, never a verdict.',
      '    exit precedence:       a finding (1) outranks a refused cleanup; a refused cleanup raises only a no-finding',
      '                         0 to 6 and is otherwise disclosed beside the comparison code. The printed exit IS',
      '                         the process exit.',
      '    its two runs DO appear in `report` (each side is an ordinary gate-bearing evaluate run); report discloses',
      '    them under comparison_sourced_runs and leaves every existing denominator unchanged.',
      '',
      'history census (failure REGIONS and classified CANDIDATES; command-local exit codes',
      '0 no failure region | 1 at least one failure region | 2 usage/refused | 4 a commit is ERROR | 5 the range is',
      'UNDETERMINED. 3 is NEVER emitted, none of these is an evaluate exit code, and a census changes no LEDGER state):',
      '  census --from=<ref> --to=<ref> --step=<name> --task=<id> [--gate=<name>] [--keep]',
      '         [--gate-env=sanitised|inherited] [--fingerprint=metadata|content] [--json] [--out=<absolute-new-path>]',
      '         [--census-session=<token>]',
      '    Enumerates EXACTLY the commits --from..--to (a single ancestry path; a range that has no linear order is',
      '    refused BY NAME rather than having one chosen for it) and measures each one through the ordinary',
      '    `workspace prepare` + `evaluate --step` path, so every row carries the same provenance a comparison side',
      "    carries today. Each commit's workspace is reclaimed as it is measured, so a long range costs one worktree",
      '    at a time rather than one per commit.',
      '    matrix:              every commit as PASS | FAIL | UNDEFINED | INCONCLUSIVE | ERROR, with its full',
      "                         provenance. UNDEFINED (the judged commit's own manifests declare no such script) is a",
      '                         distinct outcome, is ENUMERATED, is never a FAIL and is never skipped.',
      '    failure_regions:     each contiguous run of FAIL commits, with its 40-hex start and end commit and length.',
      '    observed_transitions: every adjacent PASS->FAIL and FAIL->PASS, with the evidence available at it.',
      '    classifications:     a 5-way mechanical cascade — TEST_EVOLUTION, CROSS_PACKAGE_MIGRATION,',
      '                         CROSS_PACKAGE_COMPLETED, PREDICATE_DESIGN, SOURCE_CHANGE — ALL rules asked, none',
      '                         short-circuited. MORE THAN ONE FIRING IS INCONCLUSIVE, and so is any transition whose',
      '                         evidence is unreadable. There is no precedence among the rules to break a tie.',
      "    candidates:          the commit at each region's PASS->FAIL boundary, named `candidate`, and never as the",
      '                         responsible party. A transition is not a cause: a candidate can be the boundary and',
      '                         still be innocent. A region open at the first commit of the range has NO candidate,',
      '                         because this run compared no boundary.',
      '    monotonicity:        MONOTONE | NOT_MONOTONE | UNDETERMINED, scoped to `measured_range_only` and printed',
      '                         with that scope. MONOTONE is structurally unreachable while a reversal is present, and',
      '                         a step that PASSES at every commit is reported as carrying NO INFORMATION.',
      '    refusal:             whenever the range is non-monotone, the output states that a single boundary is NOT',
      '                         identified and why, and names the things this tool does not offer: a first bad commit,',
      '                         a midpoint, a narrowed range, and any automatic boundary search.',
      '    --census-session=<token>  resume an interrupted census: completed commits are REPLAYED from the',
      '                         append-only census log, never re-run and never rewritten. A token that already holds a',
      '                         DIFFERENT range, step, task or environment policy is REFUSED BY NAME.',
      '    NOT A SEARCH:         it never narrows, halves, samples or selects a midpoint, and it emits no "first bad',
      '                         commit". Automatic boundary search of any kind remains a recorded NO-GO with no',
      '                         command, no flag and no stub. An over-long range is refused by name;',
      "                         narrowing it is the operator's decision, not this program's.",
      '    exit precedence:      an ERROR commit (4) outranks an UNDETERMINED range (5), which outranks a finding (1);',
      '                         a refused removal is disclosed beside the code and never demotes it. The printed exit',
      '                         IS the process exit.',
      '',
      'evaluate options:',
      '  --task=<id>            required',
      '  --workspace=<path>     directory to evaluate (default: repo root); used for git + gate cwd',
      '  --gate=<name>          check (default) | check:fast | check:full | benchmark (standalone fixture only)',
      '  --claim=<text>         the completion claim made by the agent (any non-empty text)',
      '  --claim-done           shorthand for a bare "I am done" claim',
      '  --failure=<category>   human-classified failure category (validated against the taxonomy)',
      '  --acceptance=pass|fail|unknown|auto   acceptance-criteria verdict (default unknown)',
      '  --acceptance-authority=<id>   human acceptance record: who accepted (requires --acceptance=pass)',
      '  --acceptance-criteria=1,2    human acceptance record: which criteria the human judged (fail-closed scope)',
      '  --acceptance-basis=<text>    human acceptance record: one bounded evidence line (max 400 chars)',
      '    a pass with no record is recorded as acceptance_record_classification=operator_trust, not as evidence',
      '  --notes=<text>         free-text run notes',
      '  --run-id=<id>          override the generated run id (bounded token, max 120 characters)',
      '  --run-origin=<label>   who asked for this run (regress stamps its own children; report discloses them)',
      '  --self-test            mark the run as a mechanics check (excluded from baseline aggregates)',
      '  --ledger=<run-id>      attach a ledger: append verification evidence and update its state',
      '  --no-gate              capture state and events without running the gate',
      '  --quiet                suppress the gate output tail on stdout',
      '  --json                 print the versioned machine verdict (harness.evaluate.verdict/1) after the summary',
      '  --no-contract          run the gate with NO contract at all. Records contract_digest: null and',
      '                         declared_source_commit: null, keeps acceptance at `unknown`, and is REFUSED with',
      '                         --ledger (a ledger is durable state bound to a contract). Mutually exclusive with --task.',
      '  --step=<name>          run ONE named step of the gate, independently and with no fail-fast. UNDEFINED is',
      '                         a distinct outcome, never a failure, and such a run still exits 1.',
      '  --fingerprint=metadata|content    installed-tree walk tier for THIS run (default: none)',
      '  --gate-env=sanitised|inherited    gate child environment (default sanitised; inherited is recorded)',
      '                                     an unrecognised value is REFUSED BY NAME, exit 2, on EVERY command',
      '',
      'contract init:',
      '  contract init --task=<id> [--title=<t>] [--category=<c>] [--size=<s>] [--acceptance-criterion=<text>]',
      '                  [--force] [--json]',
      '    Derives a MINIMAL VALID contract from the current HEAD. It exists because .harness/state/tasks/ ships',
      '    empty and there was no create command, which made every gate-bearing command unreachable. NO schema',
      '    change and no field removed: validateTask is untouched and every contract valid before is valid after.',
      '    THE SEEDED `acceptance` IS A SEED, NOT A SPECIFICATION. Nobody wrote it, so a run against a seeded',
      '    contract reports `acceptance: unknown` and keeps reporting it until a human edits the file or passes',
      '    --acceptance. The seed changes the SHAPE of the contract, never the verdict.',
      '',
      'the machine verdict (--json), and what it does NOT decide:',
      '    It is a PROJECTION of the run stream, not a new record: the full stream is still written and deleting the',
      '    verdict loses nothing. It is the LAST line of stdout and the only JSON on it, and the literal token',
      '    `harness.evaluate.verdict/1` appears on that line ONLY — gate output is fenced and has the token neutralised,',
      '    so a grep-and-parse consumer cannot reach a forged verdict object before the real one.',
      '    Its first fields are `schema`, `verdict` and `scope`, then `run_id`, `measured_at`, `judged_commit`,',
      '    `declared_source_commit`, `judged_source_status_hash` and `commits_since_source`, so a reader of the head',
      '    learns WHAT was judged, WHEN, and whether the tree carried uncommitted edits at that commit.',
      '    `GATE_PASS` IS RESERVED FOR `FULL_GATE`. `--gate=check:fast` passing on a tree whose tests fail used to',
      '    report `GATE_PASS` at exit 0, and those are the two signals a hurried reader takes first; a subset pass, a',
      '    single `--step` and `--no-gate` are all `NOT_A_GATE_PASS`. A `GATE_INCOMPATIBLE` run reports',
      '    `gate_exit_code: null` because no step ran — never 0.',
      '    `scope` is MANDATORY and is computed in-process, because GATES is a module-local constant and the',
      '    canonical step list is recorded nowhere durable:',
      '      FULL_GATE          every step of the canonical `check` gate ran and exited 0 — whole-project validation',
      '      SUBSET_GATE        a real gate passed, but it is a STRICT SUBSET of `check` (e.g. check:fast). NOT the',
      '                        same as FULL_GATE, and the exit code does not distinguish them — only this field does.',
      '      SINGLE_STEP        one named step of the gate ran (--step). One step is not the gate.',
      '      PARTIAL_FAIL_FAST  the gate stopped at its first failure; the steps after it were NOT measured.',
      "      UNDEFINED          the named step does not exist in this workspace's manifests: nothing ran, and the",
      '                        exit code is an explicit null. Never a failure.',
      '      GATE_INCOMPATIBLE  the gate cannot resolve here. No step ran; this is a SETUP failure.',
      '      NO_GATE            --no-gate: state and events were captured and no gate ran.',
      '    `gate_bearing` and `steps_total` were ADDED to the record because neither existed anywhere; without them',
      '    `check` and `check:fast` were the same decision strings at the same exit code.',
      '    `prior_observations` is a MEMORY, not a verdict: a count of prior runs of THIS judged state, their distinct',
      '    exit codes, and whether they disagreed. It asserts no rate, no bound and no exchangeability claim, and it',
      '    never resolves anything in either direction. Its `caveat` and `caveat_code` are SIBLINGS of `contradicted`,',
      '    not only prose: `contradicted: false` means no disagreement was OBSERVED in readable prior runs, and at n<2',
      '    one run cannot disagree with anything. It is not a stability claim and not a test-edit detector; none is',
      '    built. `false_done` is TRI-STATE: `null` when no completion claim was made, which is not the same as `no`.',
      '',
      'flag refusals (all at exit 2, before any workspace, install or gate):',
      `    unknown flag: refused BY NAME with the per-command allowlist printed. ${UNKNOWN_FLAG_BASIS}`,
      `    a value-flag given WITHOUT a value (--ledger instead of --ledger=<id>): refused BY NAME, with the flags`,
      `    that take no value listed. ${BARE_VALUE_FLAG_BASIS}`,
      '',
      'evaluate exit codes (command-local; `regress` and `census` publish their OWN sets and 3 is never emitted by',
      'either of them — see above):',
      ...renderEvaluateExitTable(),
      `    basis: ${EVALUATE_EXIT_BASIS}`,
      '',
      'predicate commands:',
      '  predicates [--validate] [--json]   acceptance predicate coverage, hardening hints, and',
      '                                     source-vs-solving-commit discrimination validation',
      '    [--predicate-corpus=<path>] [--predicate-inventory=<path>]   override the corpora (defaults unchanged)',
      '',
      'configuration commands:',
      '  modes [--file=.roomodes]           validate mode definitions (fail-closed; never claims isolation it cannot see)',
      '  handoff --template | --check=<f>   print/validate the structured handoff contract',
      '  self-test                          run the invariant self-tests (hermetic, no Zoo runtime)',
      '',
      'mechanical acceptance (Structural behavior):',
      '  --acceptance=auto                  run the contract acceptance_checks and derive the verdict',
      '                                     (uncovered criteria ⇒ unresolved, never pass)',
      '',
      'verifier evidence (Durable-state behavior — recorded as evidence, never as terminal authority):',
      '  --verifier-report=<path>           JSON handoff from the verifier role (verdict, artifact_integrity,',
      '                                     findings, criteria_checked, evidence; validated by handoff.mjs)',
      '  --verifier-verdict=PASS|FAIL|BLOCKED',
      '  --artifact-integrity=UNCHANGED|CHANGED|UNKNOWN',
      '  --artifact-integrity-basis=<text>  REQUIRED with an integrity observation: who/how it was produced',
      '  --artifact-integrity-kind=computed|declared   how it was produced (default: declared, never computed)',
      '  --verifier-evidence=<text>         one bounded evidence line (max 400 chars)',
      '    PASS never promotes a run; FAIL forces `failed`; CHANGED makes the verdict unusable (`blocked`)',
      '',
      'telemetry snapshot (Structural behavior):',
      '  --telemetry-store=<dir> [--store-task-id=<id>]',
      "                                     copy this run's runtime metrics; missing ⇒ unavailable, never 0",
      '',
      'optional runtime metrics (only if the runtime actually exposes them — never fabricated):',
      '  --model=<name> --turns=<n> --tool-calls=<n> --input-tokens=<n> --output-tokens=<n>',
      '  --cached-tokens=<n> --cost=<number>',
      '',
      'optional run context (written into run events when supplied):',
      '  --experiment=<id> --arm=<label> --role=<label>',
      '  --tool-profile=<label> --mcp-profile=<label>',
      '',
      "telemetry (Runtime telemetry — reads the RUNNING RUNTIME's own task store, operator side):",
      '  telemetry --task-dir=<id|path> [--store=<tasks-dir>] [--out=<path>]',
      '  telemetry --scan [--store=<tasks-dir>] [--out=<path>]',
      '    Values are copied from the store, never estimated. Not supplied by us:',
      '    --store=… or the ZOO_TASK_STORE environment variable (no host path is hardcoded here).',
      '',
      'ledger commands (durable execution state — see .harness/docs/ledger.md):',
      '  ledger init --task=<id> [--arm=<label>] [--run-id=<id>] [--workspace=<path>]',
      '  ledger set  --task=<id> [--run-id=<id>] [--status=<s>] [--completed=<text>] [--pending=<text>]',
      '              [--claim=<text>] [--failure=<category>:<note>] [--clear-pending]',
      '  ledger show --task=<id> [--run-id=<id>] [--json]',
      '  ledger forensic --run-id=<id> [--json|--raw]  non-causal bytes and diagnostics only',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------- per-command help
//
// WHY THIS EXISTS. `harness <command> --help` was REFUSED as an unknown flag, by name, at exit 2 — the very refusal that
// exists so `evaluate --acceptence=pass` cannot be mistaken for a granted capability. An agent asking the CLI how it
// works was therefore treated as making a refused request, and the only help that existed was the whole top-level block,
// larger than the whole of `AGENTS.md`. This adds a per-command help, and it adds it as a MODE OF INVOCATION rather than
// as a flag. See the comment at the interception in `main()` for why it must never become an allowlist entry.
//
// TWO PROPERTIES BESIDES BEING SHORT.
//   1. NOTHING IS SILENTLY DROPPED. A help request that carries other tokens prints the tokens it did not act on. A
//      request that was neither granted nor disclosed is the same defect the flag refusal exists to kill, and a screen
//      that quietly swallowed the rest of the command line would be that defect in a new costume.
//   2. NO SIDE EFFECTS. This is the only path that writes to stdout having measured nothing: it creates no workspace, no
//      run, no contract, no report and no ledger line, which is what the compatibility cases assert about
//      `.harness/state`.
//
// THE EXIT TABLES ARE RENDERED FROM THE CONSTANTS THE EXIT SITES USE, and never re-described. `renderEvaluateExitTable()`
// is SHARED with `printHelp()`, so the two screens cannot disagree about a number. `regress` and `census` publish the
// NAME of the constant that carries each of their numbers, so a reader can trace a printed number to the code that
// returns it, and the constants that carry a meaning not already in a name are rendered whole. NO NEW EXIT-CODE PROSE
// IS WRITTEN HERE.
//
// WHAT IS DELIBERATELY ABSENT: the measured evidence — the commit, the trial counts, the census figures, the NO-GO
// falsifier criterion — and the byte-floor arithmetic. Those belong to the reference layer, read when a result is being
// judged. A screen read at the moment of use, every time, stops being read above a few kilobytes, and a screen carrying
// the measurements is a screen nobody reads.
// FIX B3 RAISED BOTH NUMBERS, and the budget now protects something it did not protect before.
//
// WHAT IT PROTECTS: that a screen stays a SCREEN — the block an agent reads at the moment it decides what to type.
// The bound is not there to make the screens short out of taste; it is there so that a screen cannot quietly become
// the reference layer, which is what `.harness/README.md` is for and what stops being read when it grows.
//
// WHAT CHANGED. `evaluate` was 3 000 against a measured 2 976 — 24 bytes of headroom on a screen that permits FORTY
// flags and named about ten of them. The two omissions were both ways of sending someone to measure the wrong tree:
// the screen never mentioned `--workspace=<path>`, so following the procedure literally measured the working tree
// rather than a prepared one, and it never mentioned that the census is bounded, so a range over-long was discovered
// by being refused. Raising the bound is what lets a screen name every flag its allowlist permits: the complete
// `evaluate` roster is seven wrapped lines, and a bound that forbids naming a flag the command accepts is a bound
// that rewards the screen for being incomplete.
//
// The figures are ceilings with slack, not targets. A screen that stops naming its flags does not get to keep the
// slack; `I33` asserts both the budget and the coverage, so the slack can only be spent on the flags.
//
// `evaluate` is 4 000 rather than the 3 500 this pass was asked for, and the reason is measured rather than
// preferred: naming all forty allowlisted flags costs seven wrapped lines, and with `--workspace` the screen comes to
// 3 796 bytes. A 3 500 ceiling could only be met by dropping flags off the screen, which is the exact defect the
// coverage assertion exists to prevent — a bound that forbids documenting a flag the command accepts rewards the
// screen for being incomplete. 4 000 is the smallest round figure above the measured 3 796, so the slack is 204
// bytes rather than a margin wide enough to hide a regression. `default` is 4 500 and is not near its bound: the
// largest screen under it is `regress` at 3 637.
//
// THE FIGURES IN THIS COMMENT ARE MEASURED, SO `I33` ASSERTS THEM AGAINST A LIVE RUN. A comment whose whole point is
// that its numbers are measured must not be allowed to go stale: this one carried `3 436` for `regress` while the
// screen measured 3 637, because prose drifts and a code path does not. The `i33CommentFigures` assertion below parses
// the figures out of THIS comment as source text and compares each against `commandHelpBody`, so a drifted figure
// reddens the suite instead of misleading the next reader, and it PRINTS the comment's number beside the measured one.
const COMMAND_HELP_BUDGET = { evaluate: 4000, default: 4500 };

/** The evaluate exit table, rendered once, for the top-level help and for `evaluate --help` alike. */
function renderEvaluateExitTable() {
  return EVALUATE_EXIT_TABLE.map(([code, meaning, scope]) => `  ${code}  ${meaning}\n       scope: ${scope}`);
}

/**
 * FIX B3: the COMPLETE set of flags one command accepts, rendered from the SAME `COMMAND_FLAG_ALLOWLIST` and
 * `COMMAND_BOOLEAN_FLAGS` entries the unknown-flag refusal prints.
 *
 * WHY A RENDERED ROSTER. The refusal prints the allowlist when a caller guesses wrong, which means the allowlist is
 * already the authoritative answer to "what does this command take". A screen that names only some of it is therefore
 * not a shorter truth, it is a partial one: a reader who trusts the screen cannot tell the difference between a flag
 * the command refuses and a flag the screen forgot. `evaluate` was the worst case — forty flags accepted, about ten
 * named — and `--workspace=<path>` was among the missing ones, which is a flag whose absence sends a reader to measure
 * the wrong tree.
 *
 * DERIVED, NOT TYPED, and that is the part that matters. The roster is built from the constant at call time, so it
 * cannot fall behind the allowlist: a newly allowlisted flag appears on the screen because the screen is the allowlist.
 * `I33` asserts the coverage by reading the same constant from SOURCE TEXT and requiring every entry in the rendered
 * body, so the two are independent readings that have to agree.
 *
 * A command with subcommands (`workspace`, `ledger`) is deliberately NOT rendered this way: its flags belong to a
 * subcommand, and one flat roster per command would print flags for a subcommand the reader did not ask for. Those
 * screens document their flags in their usage block, where the subcommand is named.
 */
function renderAcceptedFlagRoster(command, width = 104) {
  const entry = COMMAND_FLAG_ALLOWLIST[command];
  const booleans = COMMAND_BOOLEAN_FLAGS[command];

  // A subcommand-shaped entry is an object, not a flag list; the caller documents those in its usage block instead.
  if (entry !== undefined && !Array.isArray(entry)) return [];
  const flags = [
    ...new Set([...(Array.isArray(entry) ? entry : []), ...(Array.isArray(booleans) ? booleans : [])]),
  ].sort();

  if (flags.length === 0) return [];
  const lines = [];
  let line = '  ';

  for (const flag of flags) {
    const token = `--${flag}`;

    if (`${line}${token} `.length > width) {
      lines.push(line);
      line = `  ${token} `;
      continue;
    }
    line += `${token} `;
  }
  if (line.trim() !== '') lines.push(line);

  return lines;
}

/** The one-line disclosure for tokens a help request carried and did not act on. Never printed when there are none. */
const HELP_UNDISCLOSED_PREFIX = 'other arguments supplied and not acted on:';

const COMMAND_HELP = {
  evaluate: () => [
    'harness evaluate — run the gate on one judged tree, publish a verdict',
    '',
    'usage: harness evaluate --task=<id> [options] | --no-contract [options]',
    `exactly one of --task=<id> / --no-contract; both or neither is a refusal at exit ${UNKNOWN_FLAG_EXIT}.`,
    '',
    'selection:',
    '  --task=<id>            the contract; its acceptance and source commit travel with it',
    '  --no-contract          no contract; the record carries contract_digest: null',
    // FIX B3. Omitting this flag from the screen was not a style choice: `evaluate` measures the WORKING TREE unless
    // this names a prepared workspace, so an agent that followed the screen literally measured the tree it was sitting
    // in rather than the one the procedure was about. One line, and the consequence is on the same line.
    '  --workspace=<path>     the tree to measure (default: the working tree); naming a prepared workspace is what',
    '                         makes the verdict about THAT tree rather than this one',
    `  --gate=<name>          default: ${CANONICAL_GATE} · --step=<name> one step, not the gate · --no-gate no gate runs`,
    `  --fingerprint=<tier>   ${TREE_FINGERPRINT_TIERS.join(' | ')}`,
    `  --gate-env=<policy>    ${GATE_ENV_POLICIES.join(' | ')}; default: ${GATE_ENV_DEFAULT_POLICY}`,
    '  --json                 the versioned verdict projection; --quiet silences the human block',
    '  --ledger=<id>          attach this run to a durable ledger',
    '  optional: run context, verifier evidence, telemetry, metrics',
    `  any other flag is REFUSED BY NAME at exit ${UNKNOWN_FLAG_EXIT}, with this allowlist printed.`,
    // FIX B3: the COMPLETE roster, rendered from the same allowlist the refusal prints. Every flag the command accepts
    // is named here, so a flag that exists but is undocumented cannot mislead anybody. It is derived rather than typed,
    // which is what makes `I33`'s coverage check a derivation too: the roster cannot fall behind the allowlist,
    // because it is built from the allowlist.
    '  every flag this command accepts, and nothing else:',
    ...renderAcceptedFlagRoster('evaluate'),
    '',
    'exit codes (`regress`/`census` publish their OWN sets; 3 is emitted by none of the three):',
    ...renderEvaluateExitTable(),
    '',
    'four things a verdict does NOT decide:',
    '  GATE_PASS is reserved for scope FULL_GATE; every other scope reads NOT_A_GATE_PASS',
    '  GATE_INCOMPATIBLE reports gate_exit_code: null, never 0 — no step ran',
    '  prior_observations is a MEMORY of prior runs, not a verdict: no rate, no bound',
    '  the head is an ordered prefix of NINE keys; the ORDER is the contract, not a byte window',
    '',
    'the `--json` machine surface is the LAST line of stdout and nothing else; gate output is fenced and the',
    'verdict token neutralised. A worktree is not a security boundary: a same-principal writer controls gate and',
    'contract, so no field here proves a result authentic.',
    '',
    'basis: `harness --help` · fields: .harness/docs/schemas.md · surface: .harness/README.md',
    '`regress`, `census` and `workspace` have their own `--help`.',
  ],
  regress: () => [
    'harness regress — compare two commits, each prepared and evaluated in its own workspace',
    '',
    'usage:',
    '  harness regress --good=<ref> --target=<ref> --task=<id> [options]',
    '  options: --gate=<name> --step=<name> --keep --json --out=<absolute-new-path>',
    '           --gate-env=<policy> --fingerprint=<tier> --repeat=<1..299> --repeat-session=<token>',
    '           --confirm-disagreement',
    '',
    // FIX B3. This roster is here because the coverage assertion FOUND a hole rather than because the screen looked
    // thin: `regress` accepted `--no-gate` and the screen never named it, so a caller reading only the screen could not
    // tell that the gate can be suppressed on a comparison run. That is the check earning its keep on the first run.
    '  every flag this command accepts, and nothing else:',
    ...renderAcceptedFlagRoster('regress'),
    '',
    'two INDEPENDENT sides: each ref gets its own workspace instance and its own evaluate run, so the ordinary gate,',
    'run stream, acceptance machinery and environment record are used unchanged.',
    `side states: ${REGRESS_SIDE_STATES.join(' | ')}`,
    '  INCONCLUSIVE is neither PASS nor FAIL: never counted as a pass, never as a fail, and never resolving a',
    '  comparison in either direction. ERROR is a statement about the TOOL; INCONCLUSIVE about the EVALUATED STATE.',
    `verdicts: ${REGRESS_VERDICTS.join(' | ')}`,
    `  by default every verdict is derived from ${REGRESS_VERDICT_BASIS_TEXT}.`,
    '',
    'exit set (rendered from the constants the exit sites return; none of these is an evaluate exit code, and 3 is',
    'NEVER emitted — a comparison command that never runs a gate must not be able to produce evaluate 3):',
    `  ${REGRESS_EXIT_NO_FINDING}  REGRESS_EXIT_NO_FINDING     ${REGRESS_EXIT_SIDE_ERROR}  REGRESS_EXIT_SIDE_ERROR`,
    `  ${REGRESS_EXIT_FINDING}  REGRESS_EXIT_FINDING        ${REGRESS_EXIT_INCONCLUSIVE}  REGRESS_EXIT_INCONCLUSIVE`,
    `  ${REGRESS_EXIT_USAGE}  REGRESS_EXIT_USAGE          ${REGRESS_EXIT_CLEANUP_FAILED}  REGRESS_EXIT_CLEANUP_FAILED`,
    `  ${REGRESS_EXIT_INCONCLUSIVE}: ${REGRESS_EXIT_FIVE_BASIS}`,
    `  precedence: ${REGRESS_EXIT_PRECEDENCE}`,
    '',
    // REPEAT_CLASSIFICATION_RULE carries BOTH halves of the rule the screen has to state: the contradiction boundary
    // and the sentence that a vote is never used. REPEAT_VOTE_FORBIDDEN restates the second half in isolation and is
    // omitted for the byte budget; the sentence is here, verbatim, inside the rule.
    `--repeat=<1..${REPEAT_MAX_TRIALS}>  ${REPEAT_CLASSIFICATION_RULE}`,
    '--confirm-disagreement  opt-in and NON-AUTHORITATIVE: it re-runs the failing step once on the disagreeing side and',
    '  reports both observations. It never flips a verdict and asserts no direction; a second observation that',
    '  CONTRADICTS the first WITHDRAWS the direction to cannot_compare, which is a refusal and never a replacement.',
    'automatic boundary search is a recorded NO-GO: no command, no flag and no stub.',
    '',
    'regress attaches no ledger and sets no status; both sides appear in `report` as comparison_sourced_runs.',
    '`evaluate --help`, `census --help` and `workspace --help` carry their own exit sets.',
  ],
  census: () => [
    'harness census — measure a RANGE of commits for failure regions',
    '',
    'usage:',
    '  harness census --from=<ref> --to=<ref> --step=<name> --task=<id> [options]',
    '  options: --gate=<name> --keep --json --out=<absolute-new-path> --gate-env=<policy> --fingerprint=<tier>',
    '           --census-session=<token>',
    '',
    'a census is NOT a search: it enumerates exactly the commits --from..--to names, reports every one of them, and',
    'never narrows, halves, samples, selects a midpoint, proposes a next commit or emits a "first bad commit". It reuses',
    'the regress per-commit machinery — the same workspace prepare, the same `evaluate --step`, the same trial-log',
    'writer — under a role of its own, and a census is a finding about a RANGE, never a direction about one commit.',
    '',
    // FIX B3. Two things this screen omitted, and both are discovered the expensive way when they are missing. The
    // range is bounded, and the bound is a COST bound: an over-long range is refused BY NAME before any workspace
    // exists, so an operator who does not know the bound learns it from a refusal rather than from the screen. And the
    // range must be a single ancestry path: where two branches diverge there are several linear orders of the same
    // commits, and this program refuses to pick one rather than silently choosing which history to describe.
    `  range bound:           at most ${CENSUS_MAX_COMMITS} commits (--from..--to inclusive); a longer range is refused`,
    '                         BY NAME before any workspace is created, and the only way past it is to name a shorter',
    '                         range yourself — this program will not split, sample, or measure a subset of the range',
    '                         and report it as the whole',
    '  ancestry rule:         --from must be an ancestor of --to. A range across diverged branches has no single',
    '                         linear order, so it is REFUSED BY NAME with both commits printed; choosing between two',
    '                         orders is a decision about which history to describe, and it belongs to the operator',
    '',
    '  every flag this command accepts, and nothing else:',
    ...renderAcceptedFlagRoster('census'),
    '',
    'exit set (rendered from the constants the exit sites return; none of these is an evaluate exit code, and 3 is',
    'NEVER emitted):',
    `  ${CENSUS_EXIT_NO_FINDING}  CENSUS_EXIT_NO_FINDING     ${CENSUS_EXIT_COMMIT_ERROR}  CENSUS_EXIT_COMMIT_ERROR`,
    `  ${CENSUS_EXIT_FINDING}  CENSUS_EXIT_FINDING        ${CENSUS_EXIT_UNDETERMINED}  CENSUS_EXIT_UNDETERMINED`,
    `  ${CENSUS_EXIT_USAGE}  CENSUS_EXIT_USAGE`,
    `  rule: ${CENSUS_EXIT_RULE.rule}`,
    '  a census changes no LEDGER state and writes no ledger at all.',
    '',
    '`evaluate --help`, `regress --help` and `workspace --help` carry their own exit sets.',
  ],
  workspace: () => [
    'harness workspace — prepare, remove, prune, show and list historical workspaces',
    '',
    'usage:',
    '  harness workspace prepare --commit=<ref> [--instance=<label>] [--offline] [--no-install] [--no-build]',
    '                           [--build-command=<argv>] [--gate=<name>] [--step=<name>] [--keep] [--force]',
    '                           [--npm-cache=<dir>] [--fingerprint=<tier>] [--gate-env=<policy>]',
    '                           [--ignore-scripts] [--accept-inherited-env=<NAMES>] [--accept-lockfile-version]',
    '                           [--accept-pm-mismatch]',
    '  harness workspace remove  --commit=<ref> [--instance=<label>] [--force]',
    '  harness workspace prune   [--stale-after=<30m|2h|7d>] [--force]',
    '  harness workspace show    --commit=<ref> [--instance=<label>] [--json]',
    '  harness workspace list',
    '',
    'prepare resolves the commit, creates a detached linked worktree at a root OUTSIDE the repository, and refuses an',
    'ancestor node_modules, a symlinked node_modules, a missing lockfile, an unsupported lockfileVersion and an npm',
    "cache INSIDE the repository BEFORE any install is spent. It then installs from the commit's OWN lockfile, builds",
    'inside the worktree by default, writes the attestation and prints the environment. A build is EXECUTED with no',
    'neutraliser and the record says so.',
    `fingerprint tiers: ${TREE_FINGERPRINT_TIERS.join(' | ')} (default: ${TREE_FINGERPRINT_DEFAULT_TIER})`,
    `states: ${WORKSPACE_STATES.join(' | ')}`,
    '',
    'exit set (rendered from the constants the exit sites return; 0 is success, none of these is an evaluate exit code,',
    'and a worktree is not a security boundary):',
    '  0  success',
    `  ${WORKSPACE_EXIT_USAGE}  WORKSPACE_EXIT_USAGE      (a refusal, always decided before any install is spent)`,
    `  ${WORKSPACE_EXIT_ENVIRONMENT}  WORKSPACE_EXIT_ENVIRONMENT  (the environment could not be produced)`,
    '',
    '`evaluate --help`, `regress --help` and `census --help` carry their own exit sets.',
  ],
  contract: () => [
    'harness contract — derive a task contract from the current HEAD',
    '',
    'usage:',
    '  harness contract init --task=<id> [--title=<t>] [--category=<c>] [--size=<s>]',
    '                         [--acceptance-criterion=<text>]... [--json] [--force]',
    '',
    'writes .harness/state/tasks/<id>.json from the current HEAD, which is what makes `evaluate --task=<id>` reachable',
    'at all. The derived acceptance is a SEED and is recorded as one: a run whose acceptance nobody wrote reports',
    `false_done: null rather than a confident no. An unknown flag is REFUSED BY NAME at exit ${UNKNOWN_FLAG_EXIT}.`,
    '',
    '`evaluate --help`, `regress --help` and `workspace --help` carry their own exit sets.',
  ],
  report: () => [
    'harness report — aggregate run streams into a new report file',
    '',
    'usage:',
    '  harness report [--out=<absolute-new-path>]',
    '',
    'every gate-bearing run under .harness/state/runs/ becomes a row. A run sourced from a `regress` or `census` side',
    'is disclosed under comparison_sourced_runs and never silently folded into a denominator.',
    `An unknown flag is REFUSED BY NAME at exit ${UNKNOWN_FLAG_EXIT}.`,
    '',
    '`evaluate --help`, `regress --help` and `workspace --help` carry their own exit sets.',
  ],
  validate: () => [
    'harness validate — validate task contracts',
    '',
    'usage:',
    '  harness validate [task-id ...]',
    '',
    'with no id, every contract under .harness/state/tasks/ is validated. A malformed contract is named by its id and',
    'by what is missing, and a refusal is decided before anything is measured. This command takes no flags, so an',
    `unknown flag is REFUSED BY NAME at exit ${UNKNOWN_FLAG_EXIT}.`,
    '',
    '`evaluate --help`, `regress --help` and `workspace --help` carry their own exit sets.',
  ],
};

/**
 * The help body for one command, or `null` when that command has none. `null` is NOT a failure: it is how the
 * interception in `main()` declines to handle a command and lets the dispatch switch run unchanged, so a command
 * without per-command help keeps its previous behaviour rather than becoming an error.
 */
function commandHelpBody(command) {
  const build = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : null;

  return build === null ? null : `${build().join('\n')}\n`;
}

/**
 * Print the per-command help and exit 0. `rest` is everything after the command; the help tokens themselves are
 * consumed and everything else is DISCLOSED rather than dropped.
 *
 * Returns `null` when the command has no per-command help, so the caller can fall through to the switch.
 */
function printCommandHelp(command, rest = []) {
  const body = commandHelpBody(command);

  if (body === null) return null;

  discloseUndisclosedTokens(rest);
  process.stdout.write(body);

  return 0;
}

/** The tokens a help request carried and did not act on, named once each. Never printed when there are none. */
function discloseUndisclosedTokens(rest) {
  const other = rest.filter((token) => token !== '--help' && token !== '-h');

  if (other.length > 0) process.stdout.write(`${HELP_UNDISCLOSED_PREFIX} ${other.join(' ')}\n`);

  return other;
}

/**
 * FIX B1: the help answer for a command that has NO per-command screen. Prints the top-level screen and returns 0,
 * and the caller RETURNS that 0 — the dispatch switch is never reached, so asking never runs.
 *
 * It calls the SAME `printHelp()` the `default` arm calls, which is what keeps the bytes identical: the top-level
 * screen is one rendering with two callers, not two renderings. The disclosure is the same one, so `show --help
 * some-id` still NAMES the id it did not act on instead of dropping it — the fix changes which screen is printed, not
 * whether the caller is told what happened to their arguments.
 */
function printTopLevelHelpForHelpToken(rest) {
  discloseUndisclosedTokens(rest);
  printHelp();

  return 0;
}

// ---------------------------------------------------------------- unknown-flag refusal
//
// `parseFlags` used to accept ANY `--x=y` and to discard any non-`--` token without a word. Two failures came out of
// that, and neither is detectable from the output:
//
//   evaluate --task=FIX1 --totally-bogus-flag=xyz --repeat=99 --no-gate   →  exit 1, not one word about EITHER flag
//   evaluate --task=FIX1 --acceptence=pass                                →  exit 0, and "acceptance: unknown"
//
// The second is the dangerous one. A real capability was requested with a typo, the capability was not granted, and
// the harness reported a successful run — the "it said it did X and it did not" class, and the one an agent cannot
// detect by reading. An unrecognised flag is therefore REFUSED BY NAME, before any workspace, install or gate, and the
// allowlist for that command is printed so the caller can see exactly what would have been accepted. A refusal costs
// nothing, which is the whole point of doing it at the boundary.
//
// The allowlist is per command, and per subcommand where a command has subcommands. It is derived from the flags those
// code paths actually read — including the ones read INDIRECTLY, through `resolveGateName` (`--gate`), `resolveStepFlag`
// (`--step`, `--no-gate`), `resolveVerifierEvidence`, `workspaceInstance`, `collectExperimentContext` and
// `collectRuntimeMetrics`. It is a superset of what each command reads today, so no existing invocation changes meaning
// and no caller in this repository is refused a flag it was entitled to pass.
const COMMAND_FLAG_ALLOWLIST = {
  // The gate-bearing command. `--json` is the versioned verdict projection (change 3).
  evaluate: [
    'acceptance',
    'acceptance-authority',
    'acceptance-basis',
    'acceptance-criteria',
    'arm',
    'artifact-integrity',
    'artifact-integrity-basis',
    'artifact-integrity-kind',
    'cached-tokens',
    'claim',
    'claim-done',
    'cost',
    'experiment',
    'failure',
    'fingerprint',
    'gate',
    'gate-env',
    'input-tokens',
    'json',
    'ledger',
    'mcp-profile',
    'model',
    'no-contract',
    'no-gate',
    'notes',
    'output-tokens',
    'quiet',
    'role',
    'run-id',
    'run-origin',
    'self-test',
    'step',
    'store-task-id',
    'task',
    'telemetry-store',
    'tool-calls',
    'tool-profile',
    'turns',
    'verifier-evidence',
    'verifier-report',
    'verifier-verdict',
    'workspace',
  ],
  regress: [
    'confirm-disagreement',
    'fingerprint',
    'gate',
    'gate-env',
    'good',
    'json',
    'keep',
    'no-gate',
    'out',
    'repeat',
    'repeat-session',
    'step',
    'target',
    'task',
  ],
  census: [
    'census-session',
    'fingerprint',
    'from',
    'gate',
    'gate-env',
    'json',
    'keep',
    'no-gate',
    'out',
    'step',
    'task',
    'to',
  ],
  report: ['out'],
  modes: ['file'],
  predicates: ['json', 'validate'],
  handoff: ['check', 'template'],
  telemetry: ['out', 'scan', 'store', 'task-dir'],
  workspace: {
    prepare: [
      'accept-inherited-env',
      'accept-lockfile-version',
      'accept-pm-mismatch',
      'build-command',
      'commit',
      'fingerprint',
      'force',
      'gate',
      'gate-env',
      'ignore-scripts',
      'instance',
      'keep',
      'no-build',
      'no-install',
      'npm-cache',
      'offline',
      // `--step` is ACCEPTED but not READ by `prepare` itself, and that is deliberate rather than an oversight:
      // `regress` and `census` both carry a named step DOWN to the preparation, so both sides of a comparison are
      // prepared under the same request and their attestations stay comparable. The per-step APPLICABILITY question is
      // answered by `evaluate` in the prepared workspace, where the manifests actually are. Refusing the flag here
      // would break that contract and would refuse a flag this repository's own comparison machinery passes.
      'step',
    ],
    remove: ['commit', 'force', 'instance'],
    prune: ['force', 'stale-after'],
    show: ['commit', 'instance', 'json'],
    list: [],
  },
  ledger: {
    // `--task` is read by the dispatcher itself, so it belongs to EVERY subcommand.
    init: ['arm', 'run-id', 'store', 'task', 'workspace'],
    set: ['blocker', 'claim', 'clear-pending', 'completed', 'failure', 'pending', 'run-id', 'status', 'task'],
    show: ['json', 'run-id', 'task'],
    forensic: ['json', 'raw', 'run-id', 'task'],
  },
  contract: {
    init: ['acceptance-criterion', 'category', 'force', 'json', 'size', 'task', 'title'],
  },
};

/**
 * Why a refusal is a refusal, in the words the refusal itself uses. Printed verbatim in the message so the reason
 * travels with the exit code and is never reconstructed by a reader.
 */
const UNKNOWN_FLAG_BASIS =
  'An unrecognised flag is refused BY NAME rather than ignored. It used to be ignored, and an ignored flag is the worst class of bug on a command line: `evaluate --task=FIX1 --acceptence=pass` exited 0 and printed "acceptance: unknown", so a real capability was requested with a typo, was not granted, and the run still reported success. A silent drop cannot be detected by the caller and is not detectable after the fact either, because the run stream never records a flag the run did not read. The refusal costs nothing — it happens before any workspace, install or gate — so there is nothing to buy by deferring it. The allowlist below is a SUPERSET of the flags this command reads today, including the ones read indirectly; it is not a narrowing, and no existing invocation changes meaning.';

/** The exit a refusal uses. `2` everywhere else in this harness is a refusal or a usage error, and this is one. */
const UNKNOWN_FLAG_EXIT = 2;

/**
 * THE FLAGS THAT TAKE A VALUE, PER COMMAND. Everything in an allowlist that is not listed here REQUIRES `=value`.
 *
 * The bare-boolean class of bug, and the reason it is fixed at the allowlist rather than at each call site. `--x=y`
 * parses to a string and `--x` parses to `true`, and a command that reads a value with `typeof flags.x === 'string'`
 * therefore treats a BARE `--x` as "no value at all" — silently. Measured on the reviewer's own reproduction:
 * `evaluate --no-contract --ledger --json` exited 0 with `GATE_PASS` and no refusal, while the documented contract says
 * `--no-contract` and `--ledger` contradict each other. The check was `typeof flags.ledger === 'string'`, so it fired
 * for `--ledger=<id>` and not for `--ledger`. That is precisely the failure mode the unknown-flag work existed to kill:
 * a capability was requested, was NOT granted, and the run still reported success.
 *
 * Enumerating the VALUE flags is safer than enumerating the boolean ones: a flag nobody remembered to classify would
 * be refused loudly on its bare form, and a flag nobody remembered to add to the allowlist is already refused by
 * name. The error is always the loud kind. Every boolean flag this harness reads appears below by name, per command.
 */
const COMMAND_VALUE_FLAGS = {
  evaluate: [
    'acceptance',
    'acceptance-authority',
    'acceptance-basis',
    'acceptance-criteria',
    'arm',
    'artifact-integrity',
    'artifact-integrity-basis',
    'artifact-integrity-kind',
    'cached-tokens',
    'claim',
    'cost',
    'experiment',
    'failure',
    'fingerprint',
    'gate',
    'gate-env',
    'input-tokens',
    'ledger',
    'mcp-profile',
    'model',
    'notes',
    'output-tokens',
    'role',
    'run-id',
    'run-origin',
    'step',
    'store-task-id',
    'task',
    'telemetry-store',
    'tool-calls',
    'tool-profile',
    'turns',
    'verifier-evidence',
    'verifier-report',
    'verifier-verdict',
    'workspace',
  ],
  regress: ['fingerprint', 'gate', 'gate-env', 'good', 'out', 'repeat', 'repeat-session', 'step', 'target', 'task'],
  census: ['census-session', 'fingerprint', 'from', 'gate', 'gate-env', 'out', 'step', 'task', 'to'],
  report: ['out'],
  modes: ['file'],
  // `predicates` declares no value flags: `--json` and `--validate` are both booleans.
  predicates: [],
  handoff: ['check'],
  telemetry: ['out', 'store', 'task-dir'],
  workspace: {
    // `accept-lockfile-version` and `accept-pm-mismatch` are BOOLEANS and belong in COMMAND_BOOLEAN_FLAGS below;
    // E14-06 passes them bare and asserts the attempt proceeds, so listing them here refused a legitimate invocation.
    prepare: [
      'accept-inherited-env',
      'build-command',
      'commit',
      'fingerprint',
      'gate',
      'gate-env',
      'instance',
      'npm-cache',
      'step',
    ],
    remove: ['commit', 'instance'],
    prune: ['stale-after'],
    show: ['commit', 'instance'],
    list: [],
  },
  ledger: {
    init: ['arm', 'run-id', 'store', 'task', 'workspace'],
    set: ['blocker', 'claim', 'completed', 'failure', 'pending', 'run-id', 'status', 'task'],
    show: ['run-id', 'task'],
    forensic: ['run-id', 'task'],
  },
  contract: {
    init: ['acceptance-criterion', 'category', 'size', 'task', 'title'],
  },
};

/** The BOOLEAN flags, for the one place that has to print them: the refusal names what the bare form should have been. */
const COMMAND_BOOLEAN_FLAGS = {
  evaluate: ['json', 'quiet', 'no-gate', 'no-contract', 'claim-done', 'self-test'],
  regress: ['json', 'keep', 'no-gate', 'confirm-disagreement'],
  census: ['json', 'keep', 'no-gate'],
  report: [],
  modes: [],
  // `--json` and `--validate` are read as `flags.X === true`. Found by the I29 partition check, which is exactly
  // what it is for: an unclassified flag is a flag whose bare form would be REFUSED for no reason, and a misclassified
  // one is a flag whose `--name=value` form is refused.
  predicates: ['json', 'validate'],
  handoff: ['template'],
  telemetry: ['scan'],
  workspace: {
    prepare: [
      'force',
      'keep',
      'no-build',
      'no-install',
      'offline',
      'ignore-scripts',
      'accept-lockfile-version',
      'accept-pm-mismatch',
    ],
    remove: ['force'],
    prune: ['force'],
    show: ['json'],
    list: [],
  },
  ledger: { init: [], set: ['clear-pending'], show: ['json'], forensic: ['json', 'raw'] },
  contract: { init: ['json', 'force'] },
};

/** Why a bare value-flag is refused. The same basis as an unknown flag, and for the same reason. */
const BARE_VALUE_FLAG_BASIS =
  'A flag that takes a value was given WITHOUT one. `--x` parses to `true` and `--x=y` parses to a string, so a bare `--ledger` reached the code as the boolean `true`, the `typeof flags.ledger === \x27string\x27` guard did not fire, the documented `--no-contract` + `--ledger` contradiction was never checked, and the run exited 0 reporting a pass with the requested capability silently not granted. That is the same class as a typo\x27d flag — a real request, not honoured, and not detectable from the output — so it is refused BY NAME, before any workspace, install or gate. The flags that take no value are listed, so the refusal says which form was expected.';

/** The value-flag list for one command, honouring a subcommand. `null` when the command declares no flags at all. */
function valueFlagsFor(command, subcommand) {
  const entry = COMMAND_VALUE_FLAGS[command];

  if (entry === undefined) {
    return null;
  }

  if (!Array.isArray(entry)) {
    return Object.hasOwn(entry, subcommand) ? entry[subcommand] : [];
  }

  return entry;
}

/** The boolean-flag list for one command. Same shape, same reasons; used only to phrase the refusal. */
function booleanFlagsFor(command, subcommand) {
  const entry = COMMAND_BOOLEAN_FLAGS[command];

  if (entry === undefined) {
    return [];
  }

  if (!Array.isArray(entry)) {
    return Object.hasOwn(entry, subcommand) ? entry[subcommand] : [];
  }

  return entry;
}

/** How a non-`--` token is treated, per command. See the note above `COMMAND_FLAG_ALLOWLIST`. */
const COMMAND_POSITIONAL_POLICY = {
  // The dispatcher already consumed the subcommand before parsing; anything left over is a mistake.
  workspace: 0,
  ledger: 0,
  // Everything below takes no positional at all. `show <id>` and `validate <id>…` never reach `parseFlags`.
  evaluate: 0,
  regress: 0,
  census: 0,
  report: 0,
  modes: 0,
  predicates: 0,
  handoff: 0,
  telemetry: 0,
  contract: 0,
};

/** The allowlist for one command, honouring a subcommand when the command has subcommands. */
function flagAllowlistFor(command, subcommand) {
  const entry = COMMAND_FLAG_ALLOWLIST[command];

  if (entry === undefined) {
    return null;
  }

  if (!Array.isArray(entry)) {
    return Object.hasOwn(entry, subcommand) ? entry[subcommand] : [];
  }

  return entry;
}

/**
 * Refuse every flag this command does not read, BY NAME, before anything is measured.
 *
 * The refusal prints the offending flag, the allowlist that would have accepted it, and the reason. It is deliberately
 * noisy: the caller is an agent that will otherwise repeat the same invocation, and a refusal nobody can act on is a
 * refusal that gets worked around.
 */
function assertKnownFlags(command, subcommand, flags, positionals) {
  const allowlist = flagAllowlistFor(command, subcommand);

  if (allowlist === null) {
    return flags;
  }

  const allowed = new Set(allowlist);
  const unknown = Object.keys(flags).filter((name) => !allowed.has(name));

  if (unknown.length > 0) {
    const where = subcommand === null ? command : `${command} ${subcommand}`;

    fail(
      [
        `unknown flag${unknown.length === 1 ? '' : 's'} for \`${where}\`: ${unknown.map((name) => `--${name}`).join(', ')}`,
        `  accepted by \`${where}\`: ${allowlist.length === 0 ? '(none)' : allowlist.map((name) => `--${name}`).join(' ')}`,
        `  refused because: ${UNKNOWN_FLAG_BASIS}`,
        `  exit: ${UNKNOWN_FLAG_EXIT} (nothing was created, installed, prepared or measured)`,
      ].join('\n'),
    );
  }

  // A flag that TAKES A VALUE, given without one. This is the second half of the unknown-flag work and the same
  // failure: `--x` parses to `true`, every `typeof flags.x === 'string'` guard treats that as "absent", and the
  // capability the caller asked for is silently not granted while the run reports success. It is checked here, over
  // the whole allowlist, rather than at the call sites that forgot — a call-site fix is only as good as the next one.
  const valueFlags = valueFlagsFor(command, subcommand);

  if (valueFlags !== null) {
    const valueSet = new Set(valueFlags);
    const bare = Object.keys(flags).filter((name) => valueSet.has(name) && flags[name] === true);

    if (bare.length > 0) {
      const where = subcommand === null ? command : `${command} ${subcommand}`;
      const booleans = booleanFlagsFor(command, subcommand);

      fail(
        [
          `flag${bare.length === 1 ? '' : 's'} needing a value ${bare.length === 1 ? 'was' : 'were'} given WITHOUT one: ${bare.map((name) => `--${name}`).join(', ')}`,
          `  refused because: ${BARE_VALUE_FLAG_BASIS}`,
          `  \`${where}\` flags that take NO value and are correct bare: ${booleans.length === 0 ? '(none)' : booleans.map((name) => `--${name}`).join(' ')}`,
          `  write the others as --name=value`,
          `  exit: ${UNKNOWN_FLAG_EXIT} (nothing was created, installed, prepared or measured)`,
        ].join('\n'),
      );
    }
  }

  const positionalLimit = COMMAND_POSITIONAL_POLICY[command] ?? 0;

  if (positionals.length > positionalLimit) {
    fail(
      [
        `\`${command}\` takes no positional argument, but got: ${positionals.join(' ')}`,
        `  refused because: a bare word after a command used to be discarded in silence, so \`${command} ${positionals[0]}\` was`,
        `    indistinguishable from the same command with no word at all — the same class of bug as a typo'd flag, and the same`,
        `    fix. If you meant a flag, write it as one (--name=value).`,
        `  exit: ${UNKNOWN_FLAG_EXIT} (nothing was created, installed, prepared or measured)`,
      ].join('\n'),
    );
  }

  return flags;
}

/**
 * `--x=y` → `{ x: 'y' }`, `--x` → `{ x: true }`.
 *
 * `command`/`subcommand` are optional and, when given, turn the parse into a REFUSAL boundary: an unrecognised flag
 * and a stray positional both fail here rather than reaching a code path that would ignore them. Callers that pass
 * neither keep the original lenient behaviour, which is what the two argument-taking commands (`show`, `validate`)
 * need — they read their own positionals and declare no flags at all.
 */
function parseFlags(args, { command = null, subcommand = null } = {}) {
  const flags = {};
  const positionals = [];

  for (const arg of args) {
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');

    if (eq === -1) {
      flags[body] = true;
    } else {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }

  if (command === null) {
    return flags;
  }

  return assertKnownFlags(command, subcommand, flags, positionals);
}

// ---------------------------------------------------------------- tasks

function loadTasks() {
  if (!existsSync(TASKS_DIR)) {
    return [];
  }

  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));

  return files.map((file) => {
    const path = join(TASKS_DIR, file);
    const raw = readFileSync(path, 'utf8');
    const problems = [];
    let task = null;

    try {
      task = JSON.parse(raw);
    } catch (error) {
      return { file, path, problems: [`invalid JSON: ${error.message}`], task: null };
    }

    problems.push(...validateTask(task, file));

    return { file, path, problems, task };
  });
}

function validateTask(task, file) {
  const problems = [];

  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    return ['task contract must be a JSON object'];
  }

  for (const field of REQUIRED_TASK_FIELDS) {
    const value = task[field];

    if (value === undefined || value === null || value === '') {
      problems.push(`missing required field "${field}"`);
    }
  }

  if (Array.isArray(task.acceptance) && task.acceptance.length === 0) {
    problems.push('"acceptance" must not be an empty list');
  }

  if (typeof task.source_commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(task.source_commit)) {
    problems.push('"source_commit" must be a git commit sha');
  }

  const workspace = task.workspace;

  if (workspace !== undefined && (typeof workspace !== 'object' || Array.isArray(workspace))) {
    problems.push('"workspace" must be an object');
  }

  if (task.failure_modes !== undefined && !Array.isArray(task.failure_modes)) {
    problems.push('"failure_modes" must be a list');
  }

  for (const mode of task.failure_modes ?? []) {
    if (!TAXONOMY_IDS.includes(mode)) {
      problems.push(`"failure_modes" contains unknown category "${mode}"`);
    }
  }

  if (task.verification !== undefined) {
    const gate = task.verification?.gate;

    if (gate !== undefined && !Object.hasOwn(GATES, gate)) {
      problems.push(`"verification.gate" must be one of: ${Object.keys(GATES).join(', ')}`);
    }
  }

  problems.push(...validateAcceptanceChecks(task));

  // Criterion-boundary behavior: the declared criterion boundaries and acceptance-evidence sources. Validated fail-closed; a contract
  // without the field stays valid and every criterion keeps an unknown boundary.
  problems.push(...validateAcceptanceBoundaries(task));

  const expectedId = file?.replace(/\.json$/, '').replace(/^TASK-/, '');

  if (task.id !== undefined && expectedId !== undefined && task.id !== expectedId) {
    problems.push(`"id" (${task.id}) must match the file name (${expectedId})`);
  }

  return problems;
}

// ---------------------------------------------------------------- contract init (change 5)
//
// WHY THIS COMMAND EXISTS. `.harness/state/tasks/` ships EMPTY and there was no way to create a contract. Every
// gate-bearing command — `evaluate`, `regress`, `census`, `ledger` — requires `--task=<id>`, and `evaluate`'s own
// advice when it has none is to run `list`, which prints "no task contracts found" and exits 0. An agent following the
// harness's own advice reaches a dead end that looks like success. The six capabilities this harness has were all
// unreachable for the primary consumer, and the reason had nothing to do with whether they were any good.
//
// NO SCHEMA CHANGE AND NO FIELD REMOVED. `validateTask` is untouched and every field it requires is written, so every
// contract that was valid before is still valid, and a hand-written contract is still the better artefact. This
// command writes the MINIMUM valid contract from facts the repository already knows: the current HEAD, and the gate.
//
// AND THE SEED IS NOT A SPECIFICATION — this is the caveat that matters, so it is printed rather than implied. The
// derived `acceptance` list is a PLACEHOLDER criterion. Nobody wrote it, so it is not a criterion: an auto-seeded
// criterion that nobody wrote is not a criterion. That is why the derived contract still reports `acceptance: unknown`
// on every run until a human passes `--acceptance` or the file is edited — the seed changes the shape of the contract,
// never the verdict.
/**
 * The task a contractless run answers. It carries the six field NAMES `validateTask` and the run stream use, and every
 * value that would be a claim is `null` rather than a plausible default: no `source_commit` (there is no declared
 * baseline), no criteria (none were asserted), no category. Nothing is invented, which is why `acceptance` stays
 * `unknown` and coverage stays unevaluated on a contractless run. It is a shape, not an answer.
 */
const CONTRACTLESS_TASK = {
  schema_version: 1,
  id: 'CONTRACTLESS',
  title: 'contractless evaluation (no contract attached)',
  category: null,
  size: null,
  source_commit: null,
  acceptance: [],
  verification: { gate: DEFAULT_GATE },
  workspace: { primary: [], secondary: [] },
};
const CONTRACT_SEED_BASIS =
  'The `acceptance` list this command writes is a SEED, not a specification. It was generated from the task title by this program; no human asserted it, so it is not a criterion anybody agreed to. It exists because `validateTask` requires a non-empty list and an empty one would make the contract invalid. A run against a seeded contract therefore reports `acceptance: unknown` and keeps reporting it until a human edits the file or passes --acceptance; the seed changes the SHAPE of the contract and never the verdict. Edit it into real criteria before treating any acceptance state as meaningful. Nothing else about the contract is derived: source_commit is the current HEAD as an OBSERVED fact, not a claim about what was executed.';

function cmdContract(args) {
  const [sub, ...rest] = args;

  if (sub !== 'init') {
    fail(`unknown contract subcommand ${sub === undefined ? '(none)' : `"${sub}"`} — init`);
    return UNKNOWN_FLAG_EXIT;
  }

  return cmdContractInit(parseFlags(rest, { command: 'contract', subcommand: 'init' }));
}

/** Derive a minimal VALID contract from the current HEAD. Refuses to overwrite one that already exists. */
function cmdContractInit(flags) {
  const taskId = typeof flags.task === 'string' ? flags.task.trim() : null;

  if (taskId === null || taskId === '') {
    fail('contract init requires --task=<id> (the contract file will be .harness/state/tasks/<id>.json)');
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(taskId)) {
    fail(`--task=<id> must be 1-120 characters of letters, digits, dot, underscore or dash (got "${taskId}")`);
  }

  if (!existsSync(TASKS_DIR)) {
    mkdirSync(TASKS_DIR, { recursive: true });
  }

  const path = join(TASKS_DIR, `${taskId}.json`);

  if (existsSync(path) && flags.force !== true) {
    fail(`a contract for "${taskId}" already exists at ${path} — pass --force to replace it, or edit it in place`);
  }

  const head = normalizeCommitSha((git(['rev-parse', '--verify', 'HEAD^{commit}'], REPO_ROOT) ?? '').trim());

  if (head === null) {
    fail('contract init needs a HEAD commit to derive source_commit from, and this repository has none');
  }

  const title = typeof flags.title === 'string' && flags.title.trim() !== '' ? flags.title.trim() : taskId;
  const category =
    typeof flags.category === 'string' && flags.category.trim() !== '' ? flags.category.trim() : 'unclassified';
  const criterion =
    typeof flags['acceptance-criterion'] === 'string' && flags['acceptance-criterion'].trim() !== ''
      ? flags['acceptance-criterion'].trim()
      : `REPLACE ME: the observable condition that makes "${title}" done.`;

  // Exactly the fields `validateTask` requires, plus `size` when supplied. No field is removed and none is renamed,
  // so a contract written here is indistinguishable in shape from a hand-written one.
  const contract = {
    schema_version: 1,
    id: taskId,
    title,
    category,
    ...(typeof flags.size === 'string' ? { size: flags.size } : {}),
    source_commit: head,
    acceptance: [criterion],
    verification: { gate: DEFAULT_GATE },
    workspace: { primary: [], secondary: [] },
  };

  if (existsSync(path)) {
    unlinkSync(path);
  }

  // THE SEED FLAG IS WRITTEN, NOT JUST PRINTED. `contract init` reported `seeded_acceptance: true` on stdout while
  // the file it wrote did NOT contain the field, so `evaluate` — which reads the FILE, not the command's output —
  // computed `acceptance.seeded` as `false` for a contract this program had just seeded. A field that exists only in
  // the output of the command that created the artifact is not a property of the artifact: the next reader, and the
  // next run, both saw `seeded: false` for a seeded contract, which is the reviewer's exact complaint in a different
  // place. The flag and its basis now travel in the contract itself, so the disclosure survives the command that made
  // it. `validateTask` tolerates the extra keys, and the digest changes — which is correct, because the contract's
  // content genuinely differs from the one that was written before.
  writeNewFileExclusive(
    path,
    `${JSON.stringify({ ...contract, seeded_acceptance: true, seed_basis: CONTRACT_SEED_BASIS }, null, 2)}\n`,
  );

  // The written contract is validated by the SAME validator every other contract goes through, and the run refuses if
  // it is invalid. A command that can write a contract the rest of the harness would reject is not a create command.
  const problems = validateTask(JSON.parse(readFileSync(path, 'utf8')), `${taskId}.json`);

  if (problems.length > 0) {
    unlinkSync(path);
    fail(`contract init wrote a contract that does not validate, and removed it:\n  - ${problems.join('\n  - ')}`);
  }

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ...contract, seeded_acceptance: true, seed_basis: CONTRACT_SEED_BASIS }, null, 2)}\n`,
    );

    return 0;
  }

  printWorkspaceSummary([
    'contract init:          written',
    `path:                   ${relative(path)}`,
    `id:                     ${taskId}`,
    `title:                  ${title}`,
    `category:               ${category}`,
    `source_commit:          ${head}  (the current HEAD, observed — not a claim about what was executed)`,
    `gate:                   ${DEFAULT_GATE}`,
    'validated:              yes — the same validateTask every hand-written contract passes',
    'seeded_acceptance:      true',
    'seed is not a spec:     a run against this contract reports `acceptance: unknown` until a human edits the file',
    '                        or passes --acceptance. The seed changes the SHAPE of the contract, never the verdict.',
    `basis:                  ${CONTRACT_SEED_BASIS}`,
    'next:                   node .harness/runtime/harness.mjs evaluate --task=' + taskId,
  ]);

  return 0;
}

function findTask(id) {
  const entry = loadTasks().find((e) => e.task?.id === id);

  if (!entry) {
    fail(`unknown task id "${id}" — run: node .harness/runtime/harness.mjs list`);
  }

  if (entry.problems.length > 0) {
    fail(`task "${id}" is invalid:\n  - ${entry.problems.join('\n  - ')}`);
  }

  return entry.task;
}

function cmdList() {
  const entries = loadTasks();

  if (entries.length === 0) {
    process.stdout.write('no task contracts found in .harness/state/tasks/\n');
    return 0;
  }

  const rows = entries.map((e) => ({
    id: e.task?.id ?? '(invalid)',
    category: e.task?.category ?? '-',
    size: e.task?.size ?? '-',
    source: e.task?.source_commit?.slice(0, 8) ?? '-',
    status: e.problems.length === 0 ? 'ok' : `INVALID (${e.problems.length})`,
  }));

  const width = (key) => Math.max(...rows.map((r) => String(r[key]).length), key.length);

  const pad = (value, len) => String(value).padEnd(len);

  process.stdout.write(
    [
      `${pad('id', width('id'))}  ${pad('category', width('category'))}  ${pad('size', width('size'))}  ${pad(
        'source',
        width('source'),
      )}  status`,
      ...rows.map(
        (r) =>
          `${pad(r.id, width('id'))}  ${pad(r.category, width('category'))}  ${pad(r.size, width('size'))}  ${pad(r.source, width('source'))}  ${r.status}`,
      ),
      '',
      `${rows.length} task contract(s)`,
      '',
    ].join('\n'),
  );

  return rows.some((r) => r.status !== 'ok') ? 1 : 0;
}

function cmdValidate(args) {
  const entries = loadTasks();
  const selected = args.length > 0 ? entries.filter((e) => args.includes(e.task?.id)) : entries;

  if (args.length > 0 && selected.length !== args.length) {
    fail(`unknown task id in: ${args.join(', ')}`);
  }

  let invalid = 0;
  let incompatible = 0;

  for (const entry of selected) {
    const label = entry.task?.id ?? entry.file;
    const commitOk = entry.task?.source_commit ? commitExists(entry.task.source_commit) : false;
    const problems = [...entry.problems];

    if (entry.problems.length === 0 && !commitOk) {
      problems.push(`source_commit ${entry.task.source_commit} does not exist in this repository`);
    }

    const gateName = entry.task?.verification?.gate ?? DEFAULT_GATE;
    // `validate` reports on the DECLARED commit's manifest. It is a reporting surface: an incompatible gate is counted
    // and printed, and the command still exits 0 unless a contract is invalid. That behaviour is preserved.
    const compatibility =
      entry.problems.length === 0 && commitOk
        ? gateCompatibility(gateName, { kind: 'commit', commit: entry.task.source_commit })
        : { problems: [] };

    if (problems.length !== 0) {
      invalid += 1;
      process.stdout.write(`FAIL         ${label}\n`);
      for (const problem of problems) {
        process.stdout.write(`               - ${problem}\n`);
      }
    } else if (compatibility.problems.length !== 0) {
      incompatible += 1;
      process.stdout.write(
        `incompat     ${label}  gate "${gateName}" cannot run at ${entry.task.source_commit.slice(0, 8)}:\n`,
      );
      for (const problem of compatibility.problems) {
        process.stdout.write(`               - ${problem}\n`);
      }
    } else {
      const boundaries = boundarySummary(entry.task);
      // Printed only when the contract declares boundaries, so contracts without the field keep their exact former line.
      const boundaryNote =
        boundaries.declared_entries > 0
          ? `  boundaries ${boundaries.criteria_with_a_boundary}/${boundaries.criteria} declared, ${boundaries.criteria_unknown} unknown`
          : '';

      process.stdout.write(
        `ok           ${label}  (source ${entry.task.source_commit.slice(0, 8)} present, gate "${gateName}" compatible)${boundaryNote}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${selected.length - invalid - incompatible}/${selected.length} contract(s) valid` +
      (incompatible === 0
        ? ''
        : `, ${incompatible} gate_incompatible (evaluation setup failure, not an agent failure)`) +
      '\n',
  );

  return invalid === 0 ? 0 : 1;
}

function cmdShow(id) {
  if (!id) {
    fail('usage: harness.mjs show <task-id>');
  }

  const task = findTask(id);

  process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);

  return 0;
}

function cmdTaxonomy() {
  process.stdout.write('Failure taxonomy (.harness/docs/failure-taxonomy.md):\n\n');

  for (const [id, description] of TAXONOMY) {
    process.stdout.write(`  ${id.padEnd(22)}${description}\n`);
  }

  process.stdout.write('');
  return 0;
}

// ---------------------------------------------------------------- evaluate

function cmdEvaluate(flags) {
  let writer = null;

  try {
    return cmdEvaluateOwned(flags, (created) => {
      writer = created;
    });
  } finally {
    if (writer?.state === 'open') {
      try {
        writer.close();
      } catch {
        fail('run writer close failed');
      }
    }
  }
}

function cmdEvaluateOwned(flags, ownWriter) {
  // BEFORE EVERYTHING, INCLUDING THE TASK LOOKUP: an unrecognised `--gate-env` is refused BY NAME with exit 2 and no run
  // stream, exactly as an unknown flag, a bare value-flag or an unknown step name already is. The fallback it replaces
  // was the safe direction, and `EVALUATE_EXIT_BASIS` promised this refusal in prose while the code coerced the value.
  assertGateEnvFlagValue(flags, (refusal) => {
    fail(
      [
        `${refusal.name}: ${refusal.reason}`,
        ...refusal.lines,
        `exit: 2 (nothing was created, installed, prepared or measured)`,
      ].join('\n'),
    );
  });

  const taskId = flags.task;
  // CONTRACTLESS RUNS. `--no-contract` runs the gate with NO contract at all, which is the reachability half of change
  // 5: a contract is the QUESTION a run answers, but an agent asking "is this tree green?" has a question and no
  // contract file, and requiring a hand-authored six-field JSON to ask it made the instrument unreachable.
  //
  // It is EXPLICIT and it is RECORDED, never inferred: `contract_digest` and `declared_source_commit` are explicit
  // nulls in the run stream and in the verdict, so a contractless run can never be confused with a contract-backed
  // one that happens to have the same gate. The synthetic task below carries the six required fields with nulls where
  // the value is genuinely unknown — no criterion is invented, so `acceptance` stays `unknown` and coverage stays
  // unevaluated. It is refused WITH a ledger, because a ledger is durable terminal state and attaching one to a run
  // with no contract would write an entry whose `source_commit` is a fiction.
  const contractless = flags['no-contract'] === true;

  // `flags.ledger !== undefined`, NOT `typeof flags.ledger === 'string'`. A bare `--ledger` parses to `true`, the
  // string guard did not fire, and the documented refusal never happened: `evaluate --no-contract --ledger --json`
  // exited 0 with a green verdict and no complaint, although the README says the two contradict each other. The
  // allowlist-level refusal above now catches the bare form first; this guard is the one that owns the MEANING, and
  // it must not depend on the shape the flag happened to be written in.
  if (contractless && flags.ledger !== undefined) {
    fail(
      'evaluate --no-contract and --ledger=<run-id> contradict each other: a ledger is durable terminal state bound to a contract, and a contractless run has no source_commit to bind it to. Attach a contract, or run without a ledger.',
    );
  }

  if (!contractless && typeof taskId !== 'string') {
    fail(
      'evaluate requires --task=<id>. Create one with `harness contract init --task=<id>`, which derives a valid contract from the current HEAD — or pass --no-contract to run the gate with no contract at all, which records contract_digest: null.',
    );
  }

  if (contractless && typeof taskId === 'string') {
    fail(
      'evaluate --no-contract and --task=<id> contradict each other: one says there is no contract, the other names one. Pick one, so the record says which it was.',
    );
  }

  const task = contractless ? CONTRACTLESS_TASK : findTask(taskId);
  const gateName = resolveGateName(flags, task);
  const steps = GATES[gateName];
  const runGate = flags['no-gate'] !== true;
  const selfTest = flags['self-test'] === true;
  const workspacePath = typeof flags.workspace === 'string' ? resolve(REPO_ROOT, flags.workspace) : REPO_ROOT;

  if (!existsSync(join(workspacePath, '.git'))) {
    fail(`--workspace is not a git working tree: ${workspacePath}`);
  }

  const ledgerRunId = typeof flags.ledger === 'string' ? flags.ledger : null;
  const ledger = ledgerRunId === null ? null : loadLedger(ledgerRunId, task.id);

  if (ledgerRunId !== null && ledger === null) {
    fail(`no ledger for run id "${ledgerRunId}" — run: harness ledger init --task=${taskId}`);
  }

  // A1: the digest of the bytes this process READ. Captured here — before the gate runs, before any wall-clock the
  // gate spends — because that is the base the eventual write is conditional on. A run that takes minutes and one
  // that takes milliseconds both start from here, and only the writer whose base is still on disk may publish.
  // `null` (no ledger attached) carries no expectation, exactly as before.
  const ledgerBaseDigest = ledgerRunId === null ? null : ledgerBytesDigest(ledgerRunId);

  // `evaluate` answers the same question about the manifests on disk in the workspace it will actually judge.
  const compatibility = gateCompatibility(gateName, { kind: 'workspace', path: workspacePath });
  // Per-step mode asks a NARROWER question — would the NAMED step resolve here? — so the whole-gate answer cannot
  // suppress it. Over most of this repository's history the whole `check` gate is undefined (its `ui typecheck` script
  // does not exist at 86 of 143 commits), and a per-step census suppressed by the whole-gate answer would be unusable
  // exactly where it is needed. The two answers are both recorded and never merged: `gate_compatibility` keeps its
  // existing whole-gate meaning, `step_scope` carries the per-step one.
  const wholeGateIncompatible = runGate && compatibility.problems.length > 0;
  const requestedStep = resolveStepFlag(flags, gateName);
  const stepScope = requestedStep === null ? null : resolveStepScope(gateName, requestedStep, workspacePath);
  const stepMode = stepScope !== null;
  // The step list the loop below iterates. One element in per-step mode, the whole gate otherwise — the SAME array
  // value on the default path, which is what keeps the ordinary run unchanged.
  const effectiveSteps =
    stepScope === null ? steps : stepScope.state === 'runnable' ? [steps[stepScope.step_position]] : [];
  // The flag that suppresses a run. A whole-gate incompatibility does; a per-step scope does not, because the named
  // step has its own answer, and a step this workspace cannot resolve is UNDEFINED rather than a refusal to judge.
  const gateIncompatible = wholeGateIncompatible && !stepMode;
  const claim =
    typeof flags.claim === 'string' ? flags.claim : flags['claim-done'] === true ? 'agent claimed completion' : null;
  const failure = typeof flags.failure === 'string' ? flags.failure : null;

  if (failure !== null && !TAXONOMY_IDS.includes(failure)) {
    fail(`unknown --failure category "${failure}" (see: node .harness/runtime/harness.mjs taxonomy)`);
  }

  // Structural behavior adds `auto` (run the contract's declared mechanical predicates). The default stays `unknown`, so
  // every Initial schema-5 run keeps exactly its original meaning.
  const acceptanceFlag = typeof flags.acceptance === 'string' ? flags.acceptance : 'unknown';

  if (!['pass', 'fail', 'unknown', 'auto'].includes(acceptanceFlag)) {
    fail('--acceptance must be pass, fail, unknown or auto');
  }

  const mechanicalAcceptance = acceptanceFlag === 'auto';

  // Human acceptance record: five fields, fail-closed scope, and an explicit
  // operator-trust label: a human pass with no record is still legal, but it is recorded as `operator_trust` (H3), so
  // recorded trust can never be read as measured evidence. The record never changes coverage (H2) and never grants a
  // terminal state by itself — the evaluator still applies §1.1 P1–P6.
  const humanAuthority = typeof flags['acceptance-authority'] === 'string' ? flags['acceptance-authority'] : null;
  const humanCriteriaRaw = typeof flags['acceptance-criteria'] === 'string' ? flags['acceptance-criteria'] : null;
  const humanBasis = typeof flags['acceptance-basis'] === 'string' ? flags['acceptance-basis'] : null;
  const humanRecordSupplied = humanAuthority !== null || humanCriteriaRaw !== null || humanBasis !== null;
  let acceptanceRecord = null;
  let acceptanceRecordClassification = 'not_applicable';

  if (humanRecordSupplied && acceptanceFlag !== 'pass') {
    fail(
      '--acceptance-authority/--acceptance-criteria/--acceptance-basis describe a human acceptance act and require --acceptance=pass',
    );
  }

  if (humanRecordSupplied) {
    acceptanceRecord = {
      mechanism: 'human',
      authority: humanAuthority,
      covered_criteria: humanCriteriaRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => Number(entry)),
      basis: humanBasis,
      recorded_at: new Date().toISOString(),
    };

    const humanProblems = validateHumanAcceptance({ criteria: task.acceptance, record: acceptanceRecord });

    if (humanProblems.length > 0) {
      fail(`invalid human acceptance record: ${humanProblems.join('; ')}`);
    }

    acceptanceRecordClassification = 'attributed';
  } else if (acceptanceFlag === 'pass') {
    acceptanceRecordClassification = 'operator_trust';
  }

  // A contractless run has no declared source commit, so there is nothing to check against and nothing to fail on.
  // The baseline it is measured against is the OBSERVED judged commit, which is recorded separately and is not a
  // claim about what was executed. Inventing a source_commit here would be a baseline nobody declared.
  if (!contractless && !commitExists(task.source_commit)) {
    fail(`source_commit ${task.source_commit} does not exist in this repository`);
  }

  const runId = typeof flags['run-id'] === 'string' ? flags['run-id'] : generatedRunId(task.id);

  if (!RUN_TOKEN_RE.test(runId)) {
    fail(`invalid run id "${runId}" (expected 1-120 characters matching ${RUN_TOKEN_RE})`);
  }

  const eventsPath = resolveControlPath(RUNS_DIR, `${runId}.jsonl`);
  const logPath = resolveControlPath(RUNS_DIR, `${runId}.gate.log`);
  const startedAt = new Date();
  const startedMs = Date.now();
  const writer = createWriter(eventsPath);

  ownWriter(writer);

  const gateLogWriter = runGate ? createGateLogWriter(logPath) : null;

  const state = captureRepoState(task.source_commit, workspacePath);
  // PRE-GATE observation of the tree that is about to be judged, resolved IN the workspace the gate runs in. Two
  // observations (pre/post) are two samples, not a proof that the tree stayed fixed during the gate.
  const judgedPre = observeJudgedTree(workspacePath);

  // C11 + P2a: the environment is CONSTRUCTED once, before anything is spawned, and digested from the same object
  // the gate child actually receives. `envFacts` keeps its four original keys; the new ones are additive siblings.
  //
  // THE OPEN QUESTION, DECIDED LOUDLY. This sanitisation applies to EVERY `evaluate`, not only to a historical one, and
  // that IS a behavioural change to every pre-existing run: an operator's inherited `NODE_PATH`, `NODE_OPTIONS`,
  // `npm_config_*` or proxy no longer reaches the gate. It is NOT reverted here, for two reasons. (1) The record
  // already digests the CONSTRUCTED environment, so restoring the wider default would leave the record describing one
  // environment while the gate ran in another. (2) Making the strictness depend on a flag nobody passes would make the
  // meaning of every historical record depend on a hidden choice. So the strict default stays for every run, it is
  // RECORDED as `gate_env_policy` in every environment record, and `--gate-env=inherited` is an explicit, recorded,
  // reversible opt-out for an operator who needs the wider environment and accepts the deviation it records.
  const gateEnvPolicy = GATE_ENV_POLICIES.includes(flags['gate-env']) ? flags['gate-env'] : GATE_ENV_DEFAULT_POLICY;
  // R6: WHO asked for this run. `regress` stamps each of its two children, and `report` discloses how many of its runs
  // came from a comparison instead of pretending they were never counted. An ordinary run carries `null` and is
  // classified exactly as before.
  const runOrigin =
    typeof flags['run-origin'] === 'string' && flags['run-origin'].trim() !== '' ? flags['run-origin'].trim() : null;
  const gateEnvBundle =
    gateEnvPolicy === 'inherited'
      ? { env: { ...process.env }, excluded: [], refused: [], removed: [], accepted: [] }
      : constructChildEnv({ extra: defaultEnvironmentInput().extra, refuse: false });
  const gateEnv = gateEnvBundle.env;
  const gateResolverProbe = observeResolverProbe(workspacePath, gateEnv);
  const gateProbeClassification = classifyResolverProbe(gateResolverProbe, workspacePath);
  const gateNegativeControl = observeResolverNegativeControl(workspacePath, gateEnv);
  // Opt-in only: a default walk here would tax every ordinary `evaluate` on the 912 MB primary checkout.
  const evaluateFingerprintTier =
    flags.fingerprint === undefined ? null : treeFingerprintTierOrFail(flags.fingerprint, null);
  const gateTreeFingerprint =
    evaluateFingerprintTier === null ? null : observeInstalledTreeFingerprint(workspacePath, evaluateFingerprintTier);
  // P0. The build state is a property of the TREE THE GATE IS ABOUT TO RUN IN, so the run that runs the gate observes
  // it — not only `workspace prepare`, which wrote the attestation. Without this, a historical `evaluate` would carry
  // an environment record that says nothing about the `shared/dist` its verdict actually depended on, which is exactly
  // the blindness the measured defect exposed. The plan is derived from the OBSERVED judged commit (falling back to
  // the declared one), and `evaluate` still performs no build of its own: it OBSERVES, and records `mode: null`.
  const buildPlanForRun =
    typeof (judgedPre.commit ?? task.source_commit) === 'string'
      ? historicalBuildPlanForCommit(judgedPre.commit ?? task.source_commit)
      : null;
  const buildStateForRun =
    buildPlanForRun !== null && buildPlanForRun.packages.length > 0
      ? observeBuildState(workspacePath, buildPlanForRun, gateEnv)
      : null;
  const buildForRun = {
    mode: null,
    command: null,
    command_basis:
      'not applicable: `evaluate` performs no historical build; the build belongs to `workspace prepare`, whose attestation records it. What this run records is the BUILD STATE it observed in the tree the gate ran in',
    outcome: 'not_run',
    exit_code: null,
    duration_ms: null,
    plan_digest: buildPlanForRun?.digest ?? null,
    script_execution: null,
    // NOT "no build string could have been executed": if `workspace prepare` built this workspace, that step DID execute
    // the judged commit's own `build` string, and a reader of this record must not be told otherwise. The honest
    // statement is which step did it, and that this run's own value is unknowable rather than false.
    script_execution_basis:
      "not applicable to THIS run: `evaluate` executes no build of its own. If `workspace prepare` built this workspace, THAT step executed the judged commit's own `build` string with no neutraliser — see the workspace attestation's historical_build_command / historical_build_executed_arbitrary_scripts. Whether that code ran anything is not observable from here, so this field stays null and is never true",
  };
  // The shared input for BOTH the pre-gate run event and the post-gate ledger entry, so the two can never disagree
  // about the environment they describe.
  const environmentInput = {
    task,
    workspacePath,
    childEnv: gateEnv,
    envMeta: gateEnvBundle,
    install: { mode: 'none', outcome: 'not_run', exit_code: null, duration_ms: null, offline: null, output_tail: null },
    packageManager: packageManagerRecord({
      version: probePackageManagerVersion(gateEnv),
      declaredField: readHistoricalManifest(task.source_commit, 'package.json')?.packageManager,
    }),
    platform: { os: process.platform, arch: process.arch },
    // An `evaluate` run does not own a prepared workspace, so the workspace fields stay explicitly `null` rather than
    // being omitted. `harness workspace prepare` is what fills them in.
    workspaceKey: null,
    workspaceInstanceLabel: null,
    workspaceRootSource: null,
    workspaceRootPath: null,
    // The gate did not run when `runGate` is false or the gate is incompatible; a record that OMITTED the probe would
    // read as "nothing to probe", so it is `null` — never absent.
    resolverProbe: gateResolverProbe,
    // `evaluate` performs no historical install, so nothing is claimed about one — and `null` is the honest value, not
    // `true`: F2 established that even a real historical install cannot honestly answer this question.
    historicalScripts: null,
    gitConfig: null,
    deviation:
      gateEnvPolicy === 'inherited'
        ? 'the gate child environment was the operator shell INHERITED WHOLESALE (--gate-env=inherited); the default is --gate-env=sanitised'
        : null,
    gateEnvPolicy,
    treeFingerprint: gateTreeFingerprint,
    probeClassification: gateProbeClassification,
    negativeControl: gateNegativeControl,
    // A6: recorded for EVERY run, gate-bearing or not, because the channel is the environment's and not the gate's.
    npmConfigFiles: observeNpmConfigFiles(gateEnv),
    // P0: the observed build state of THIS workspace, additive and normalised to null on write.
    build: buildForRun,
    buildPlan: buildPlanForRun,
    buildState: buildStateForRun,
  };
  const environmentRecord = buildEnvironmentEntry({
    ...environmentInput,
    at: startedAt.toISOString(),
    runId,
    gateBearing: runGate && !gateIncompatible,
    resolverProbeRan: runGate && !gateIncompatible,
    judgedCommit: judgedPre.commit,
  });

  writer.emit('run_started', {
    run_id: runId,
    task_id: task.id,
    task_title: task.title,
    category: task.category,
    size: task.size ?? null,
    gate: runGate ? gateName : null,
    gate_definition_sha256: GATE_DEFINITION_SHA,
    workspace: relative(workspacePath),
    source_commit: task.source_commit,
    head_commit: state.head,
    branch: state.branch,
    working_tree_dirty: state.dirty,
    commits_since_source: state.commitsSinceSource,
    self_test: selfTest,
    run_origin: runOrigin,
    agent_claimed_done: claim !== null,
    agent_claim: claim,
    experiment: collectExperimentContext(flags),
    runtime_metrics: collectRuntimeMetrics(flags),
    // Additive siblings only: `environmentFacts` keeps `node`, `npm`, `platform` and `cwd` exactly as they were, so a
    // reader that ignores the new keys sees the previous record byte-for-byte.
    environment: { ...environmentFacts(workspacePath), ...environmentSummary(environmentRecord) },
    // Commit binding: what the gate is ABOUT to judge, and where. `judged_commit` is a fact about the local object
    // database of the resolved workspace — it carries no claim about any remote.
    judged_commit: judgedPre.commit,
    judged_commit_basis: 'observed',
    judged_commit_scope: judgedPre.scope,
    judged_cwd: recordedCwd(workspacePath),
    status_hash_pre: judgedPre.statusHash,
    // Additive sibling, null-normalised. The GROUPING key for `prior_observations`, and the only reason the grouping
    // can tell a dirty tree from a clean one: `status_hash_pre` moves every time this harness writes a run stream,
    // because `.harness/` is untracked, so it is not a function of the judged SOURCE state. See `observeJudgedTree`.
    judged_source_status_hash: judgedPre.sourceStatusHash,
    // EXPLICIT null on a contractless run, never absent and never a digest of a synthetic task: a consumer must be
    // able to tell "no contract was attached" from "a contract was attached and this is its digest".
    contract_digest: contractless ? null : contractDigest(task, gateName),
    started_at: startedAt.toISOString(),
  });

  // The environment observation travels in the run stream even when no judgement is made — an install that failed, a
  // workspace that was never validated, a run that was refused. This is where a reader most needs it and where the
  // ledger must stay silent.
  writer.emit('environment_observed', {
    run_id: runId,
    gate_bearing: runGate && !gateIncompatible,
    environment: environmentRecord,
  });

  writer.emit('gate_compatibility', {
    run_id: runId,
    gate: runGate ? gateName : null,
    compatibility: runGate ? (gateIncompatible ? 'gate_incompatible' : 'gate_compatible') : null,
    checked_in: relative(workspacePath),
    problems: compatibility.problems,
    // Additive and null on every whole-gate run. The whole-gate answer above is UNCHANGED and keeps its meaning; this
    // field is the separate, per-step answer, so a reader can see both without either being read as the other.
    step_scope: stepScope,
  });

  if (gateIncompatible) {
    process.stderr.write(
      `gate "${gateName}" is gate_incompatible with this workspace — evaluation setup failure, not an agent failure:\n${compatibility.problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}\n`,
    );
  }

  if (stepMode && wholeGateIncompatible) {
    // Named, and explicitly NOT the refusal above: the whole gate cannot resolve here, the named step can, and the run
    // proceeds on the named step. Printing both without this line would read as a contradiction.
    process.stderr.write(
      `per-step mode: gate "${gateName}" is gate_incompatible as a WHOLE here (${compatibility.problems.length} problem(s)), and step "${requestedStep}" is ${stepScope.state} on its own answer. The whole-gate problems are NOT applied to this run; they are recorded in the run stream and reported as a disclosure.\n`,
    );
  }

  let abortedAfter = null;
  let gateExit = 0;
  const stepResults = [];

  if (runGate && !gateIncompatible) {
    // THE SAME LOOP, over `effectiveSteps`. In per-step mode that list holds the ONE named step, so the `break` below
    // has nothing after it to skip — the fail-fast behaviour is unchanged and the loop was not modified to remove it.
    for (const [index, step] of effectiveSteps.entries()) {
      // The fence numbers the step against the WHOLE gate, so a per-step run's output still says which step of which
      // gate it came from rather than claiming to be a complete one-step gate.
      const stepIndex = stepMode ? stepScope.step_position : index;
      writer.emit('verification_started', {
        run_id: runId,
        gate: gateName,
        step: step.step,
        command: formatCommand(step),
        // The directory the gate ACTUALLY runs in (`runStep` receives `workspacePath`), not the repository root.
        cwd: recordedCwd(workspacePath),
        judged_commit: judgedPre.commit,
        judged_commit_scope: judgedPre.scope,
        // Additive, null on every whole-gate run.
        step_scope: stepScope,
      });

      const result = runStep(step, gateLogWriter, index, workspacePath, gateEnv);

      stepResults.push({
        step: step.step,
        command: formatCommand(step),
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      });

      writer.emit('verification_finished', {
        run_id: runId,
        gate: gateName,
        step: step.step,
        command: formatCommand(step),
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        output_tail: result.outputTail,
        // Additive, null on every whole-gate run.
        step_scope: stepScope,
      });

      if (flags.quiet !== true && result.outputTail.length > 0) {
        // `step.step` is the NAME; passing the object printed `[object Object]` in the fence, which named nothing.
        // The options are bound first so this stays the SINGLE `process.stdout.write(gateOutputFence(` call site the
        // A4 self-test asserts on: the fence is a presentation boundary, and a boundary a refactor can bypass is
        // not one.
        const fenceOptions = { index: stepIndex, step: step.step, total: steps.length, perStep: stepMode };

        process.stdout.write(gateOutputFence(result.outputTail, fenceOptions));
      }

      if (result.exitCode !== 0) {
        gateExit = result.exitCode;
        abortedAfter = step.step;
        break;
      }
    }
  }

  if (gateLogWriter !== null) {
    gateLogWriter.close();
  }

  // POST-GATE observation: the same three facts, re-read in the same workspace, so a commit that MOVED while the gate
  // ran is visible in the record instead of being invisible.
  const judgedPost = observeJudgedTree(workspacePath);

  // Structural behavior — mechanical acceptance. Only declared predicates are evaluated and agent prose is never an input.
  let acceptanceResults = null;
  let acceptanceAuto = null;

  if (mechanicalAcceptance) {
    const evaluated = runAcceptanceChecks(task, {
      workspace: workspacePath,
      sourceCommit: task.source_commit,
      gate: { ran: runGate && !gateIncompatible, exitCode: gateExit, name: gateName },
    });

    acceptanceResults = evaluated.results;
    acceptanceAuto = evaluated.acceptance;

    writer.emit('acceptance_evaluated', {
      run_id: runId,
      mechanism: 'mechanical',
      verdict: acceptanceAuto.verdict,
      criteria_total: acceptanceAuto.criteria_total,
      criteria_covered: acceptanceAuto.criteria_covered,
      coverage: acceptanceAuto.coverage,
      checks: evaluated.results,
    });
  }

  const acceptanceVerdict = mechanicalAcceptance ? acceptanceAuto.verdict : acceptanceFlag;
  const acceptanceSource = mechanicalAcceptance ? 'mechanical' : acceptanceFlag === 'unknown' ? 'none' : 'human';

  // Structural behavior — telemetry snapshot. A store that cannot be read yields `unavailable`, never zeros.
  const telemetry =
    typeof flags['telemetry-store'] === 'string'
      ? snapshotTelemetry(flags['telemetry-store'], flags['store-task-id'])
      : null;

  const workspace = captureWorkspaceChange(task.source_commit, workspacePath);

  writer.emit('workspace_changed', {
    run_id: runId,
    source_commit: task.source_commit,
    changed_files: workspace.files,
    changed_file_count: workspace.files.length,
    truncated: workspace.truncated,
    diffstat: workspace.diffstat,
  });

  // ONE NAMED STEP IS NOT THE GATE. `mechanicallyVerified` is the field a terminal state is derived from and the only
  // thing that makes `evaluate` return 0, so a per-step run must never set it: a step that exited 0 says nothing about
  // the steps that were not run. `stepExitCode` is what the step actually did, kept separate from `gateExit` so a
  // reader is never handed a whole-gate-looking number for a one-step observation.
  const mechanicallyVerified = runGate && !gateIncompatible && gateExit === 0 && !stepMode;
  // An UNDEFINED step has no exit code at all, and `0` is the one number that would silently read as a pass. So the
  // reported value is an explicit null, and `deriveFailure` is never handed a 0 that means "nothing ran".
  const stepExitCode = stepScope !== null && stepScope.state === 'UNDEFINED' ? null : gateExit;
  const derivedFailure =
    failure ??
    (gateIncompatible
      ? 'environment'
      : stepScope !== null && stepScope.state === 'UNDEFINED'
        ? null
        : deriveFailure(gateExit, stepResults));
  const finishedAt = new Date();
  // The MEASUREMENT timestamp, not the start one: a freshness check compares this against the time the tree was
  // edited, and a run that took 90 s is fresh at its end. It is what makes a SAVED verdict distinguishable from a
  // fresh one for the same commit (B4).
  const measuredAt = finishedAt.toISOString();

  // Durable-state behavior — verifier evidence is recorded as evidence and then interpreted by the evaluator, never by the verifier.
  const verifier = resolveVerifierEvidence(flags, runId, finishedAt.toISOString());

  if (verifier !== null) {
    writer.emit('verifier_recorded', {
      run_id: runId,
      task_id: task.id,
      verdict: verifier.verdict,
      artifact_integrity: verifier.artifact_integrity,
      criteria_checked: verifier.criteria_checked,
      findings: verifier.findings,
      source: verifier.source,
      authority: verifier.authority,
    });
  }

  const currentVerifierAdverse =
    verifier !== null && (verifier.verdict === 'FAIL' || verifier.artifact_integrity === 'CHANGED');
  // A per-step run never updates the attached ledger. `classifyLedgerStatus`, the `verification[]` shape, the 15-key
  // `evaluations[]` entry and the evaluate exit protocol are all untouched; what changes is only that a one-step
  // observation is not a whole-gate result and so derives no terminal state. The step and its provenance are in the run
  // stream, which is where a census reads them.
  const updatesAttachedLedger = ledger !== null && !stepMode && (runGate || currentVerifierAdverse);
  const gateResult = runGate
    ? stepMode
      ? 'not_run'
      : gateIncompatible
        ? 'incompatible'
        : gateExit === 0
          ? 'pass'
          : 'fail'
    : 'not_run';
  const integrityVeto =
    ledger === null || !hasUnresolvedIntegrityBlocker(ledger)
      ? 'none'
      : runGate && verifier?.artifact_integrity === 'UNCHANGED'
        ? 'cleared_by_current_unchanged'
        : 'unresolved';
  const ledgerStatus = updatesAttachedLedger
    ? classifyLedgerStatus({
        gateResult,
        acceptance: acceptanceVerdict,
        acceptanceCoverage: acceptanceAuto,
        verifier,
        integrityVeto,
      })
    : null;

  // A non-success status decided by the evaluator must carry a concrete reason (Evaluator state state-machine §6).
  const newBlockers = deriveBlockers({
    status: ledgerStatus,
    acceptanceCoverage: acceptanceAuto,
    verifier,
    at: finishedAt.toISOString(),
    runId,
  }).filter((blocker) => !(ledger?.blockers ?? []).some((existing) => existing.kind === blocker.kind));
  // A blocked status always reports a reason: the blocker this run added, or — when a recorded block still stands
  // (Recorded-block persistence integrity stickiness) — the recorded one, so a blocked status is never left unexplained.
  const blockedReason =
    newBlockers.length > 0
      ? newBlockers[0].text
      : ledgerStatus === 'blocked'
        ? ((ledger?.blockers ?? [])[0]?.text ?? null)
        : null;

  writer.emit('run_finished', {
    run_id: runId,
    task_id: task.id,
    gate: runGate ? gateName : null,
    // `stepExitCode` is `gateExit` on every whole-gate run — byte-identical — and an explicit `null` for an UNDEFINED
    // step, because there was no command and therefore no exit code. Never `0` for "nothing ran". It is ALSO an
    // explicit `null` for a `gate_incompatible` run, which is the whole-gate half of the same rule: nothing was
    // spawned there either, and `gateExit` is initialised to 0 before the loop, so this field used to report a PASS
    // for a run that ran no step at all. One function decides it (`evaluatedGateExitCode`) so the two nulls cannot
    // drift apart.
    gate_exit_code: evaluatedGateExitCode({ stepScope, stepExitCode, runGate, gateIncompatible, gateExit }),
    aborted_after: abortedAfter,
    steps: stepResults,
    // Additive, null on every whole-gate run. Carries the per-step answer, the step's own command, the manifest it was
    // checked against, and whether the ledger was deliberately left alone.
    step_scope: stepScope,
    mechanically_verified: mechanicallyVerified,
    self_test: selfTest,
    run_origin: runOrigin,
    agent_claimed_done: claim !== null,
    acceptance_verified: acceptanceVerdict === 'pass',
    acceptance_verdict: acceptanceVerdict,
    acceptance_source: acceptanceSource,
    acceptance_coverage: acceptanceAuto === null ? null : acceptanceAuto.coverage,
    // Durable-state behavior — explicit coverage: per-criterion state plus the uncovered/errored lists, so "not covered" is a named
    // outcome in the evidence stream rather than a ratio a reader has to interpret.
    acceptance_criteria: acceptanceAuto === null ? null : acceptanceAuto.criteria,
    acceptance_coverage_state: acceptanceAuto === null ? null : acceptanceAuto.coverage_state,
    acceptance_uncovered_criteria: acceptanceAuto === null ? null : acceptanceAuto.uncovered_criteria,
    acceptance_coverage_incomplete: acceptanceAuto === null ? null : isCoverageIncomplete(acceptanceAuto),
    // Integrity and human-acceptance behavior (HUMAN-ACCEPTANCE): the provenance of a human acceptance act, and whether it was attributed or is operator trust.
    acceptance_record: acceptanceRecord,
    acceptance_record_classification: acceptanceRecordClassification,
    // Strict completion: only a passing acceptance verdict counts as "accepted".
    acceptance_strict_ok: acceptanceVerdict === 'pass',
    acceptance_evidence: acceptanceResults,
    // Durable-state behavior — verifier evidence (advisory) and the evaluator's reason for a non-success status.
    verifier,
    blocked_reason: blockedReason,
    // `task_success` keeps its Initial schema-5 formula; `acceptance_strict_ok` is the Strict acceptance semantics semantics.
    task_success: mechanicallyVerified && acceptanceFlag !== 'fail',
    // Full snapshot in the evidence stream (the JSONL must be self-contained); the ledger stores it too.
    telemetry,
    // `false_done` IS TRI-STATE, and that is the fix rather than a cosmetic change. It used to be a boolean folded
    // from `claim !== null && ...`, so every run with NO claim recorded a confident `false` — "not a false done" —
    // which reads as a clean bill about a tree nobody claimed anything about.
    // `null` is the honest value when there is no claim: there is nothing that could have been falsely claimed done.
    //
    // THE SECOND `null`, and the one the review asked for. A contract whose `acceptance` list is a SEED that
    // `contract init` wrote and no human asserted (`seeded_acceptance: true`) keeps `acceptance: unknown` forever
    // (see `CONTRACT_SEED_BASIS`), so NOTHING was ever judged against a criterion. A confident `no` there would be a
    // verdict about a criterion nobody wrote — the same shape as a `PASS` read as "the project validates". So an
    // UNJUDGED acceptance is also `null`, whether or not a claim was made: the question "was this falsely claimed
    // done?" was never asked, and answering it is worse than declining to. It becomes a boolean again the moment a
    // human or the mechanical evaluator supplies a real verdict, which is the only thing that makes it answerable.
    //
    // The only other reader is `report`, which tests this field for TRUTH, so `null` and `false` count identically
    // there and no denominator moves. An incompatible gate stays `false` when a claim exists and acceptance WAS
    // judged: that is a setup failure, not an agent failure, and the status is not `false_done`.
    false_done: claim === null || acceptanceVerdict === 'unknown' ? null : !mechanicallyVerified && !gateIncompatible,
    failure_category: derivedFailure,
    failure_source:
      failure !== null
        ? 'human'
        : gateIncompatible
          ? 'gate_compatibility'
          : stepScope !== null && stepScope.state === 'UNDEFINED'
            ? 'step_undefined'
            : derivedFailure !== null
              ? 'gate'
              : null,
    gate_compatibility: runGate ? (gateIncompatible ? 'gate_incompatible' : 'gate_compatible') : null,
    gate_incompatible: gateIncompatible,
    ledger_run_id: ledger === null ? null : ledger.run_id,
    // Post-gate half of the commit binding.
    judged_commit_post: judgedPost.commit,
    status_hash_post: judgedPost.statusHash,
    ...(ledgerStatus === null ? {} : { ledger_status: ledgerStatus }),
    notes: typeof flags.notes === 'string' ? flags.notes : null,
    duration_ms: Date.now() - startedMs,
    finished_at: finishedAt.toISOString(),
  });

  if (updatesAttachedLedger) {
    ledger.gate = {
      name: runGate ? gateName : (ledger.gate?.name ?? null),
      compatibility: runGate ? (gateIncompatible ? 'gate_incompatible' : 'gate_compatible') : null,
      checked_at: finishedAt.toISOString(),
      problems: compatibility.problems,
    };
    ledger.acceptance_verdict = acceptanceVerdict;
    ledger.acceptance_mechanism = acceptanceSource;
    // Integrity and human-acceptance behavior (HUMAN-ACCEPTANCE): the five-field record plus its classification. `operator_trust` means the pass was declared
    // with no attributed authority — legal, and explicitly labelled so it is never read as measured evidence.
    ledger.acceptance_record = acceptanceRecord;
    ledger.acceptance_record_classification = acceptanceRecordClassification;

    if (acceptanceAuto !== null) {
      ledger.acceptance_coverage = acceptanceAuto.coverage;
      ledger.acceptance_checks = acceptanceAuto;
    }

    // Durable-state behavior — verifier evidence in the ledger. Compact and bounded by construction; a verifier that did not run leaves
    // the field absent on historical ledgers and null on new ones, which readers treat identically.
    if (verifier !== null) {
      ledger.verifier = verifier;
    } else if (!Object.hasOwn(ledger, 'verifier')) {
      ledger.verifier = null;
    }

    // Integrity and human-acceptance behavior (INTEGRITY-CLEARANCE, 14B rule I4): a standing integrity block is cleared only by evidence, and the ledger records
    // whether that evidence was computed or merely declared. Append-only; no existing record is rewritten.
    const clearance = integrityClearance({
      ledger,
      verifier,
      at: finishedAt.toISOString(),
      runId,
    });

    if (clearance !== null) {
      ledger.integrity_clearances = [...(ledger.integrity_clearances ?? []), clearance];
    }

    if (newBlockers.length > 0) {
      ledger.blockers = [...(ledger.blockers ?? []), ...newBlockers];
    }

    if (telemetry !== null) {
      ledger.telemetry = telemetry;
    }

    // STATE-MODEL: record only the already-decided change. This call follows classification and blocker derivation, and the
    // resulting observability-only array is never consulted by them.
    appendLedgerTransition(ledger, {
      at: finishedAt.toISOString(),
      from: ledger.status,
      to: ledgerStatus,
      source: 'evaluator',
      cause: 'harness evaluate',
      runId,
      reason: typeof flags.notes === 'string' ? flags.notes : null,
    });

    ledger.status = ledgerStatus;

    if (runGate && !gateIncompatible) {
      // A passing gate resolves outstanding pending work: archive it, never leave it stale.
      // Deterministic rule: `pending` is emptied and its items are preserved in `resolved_pending[]`
      // (audit only — they never become evidence).
      if (gateExit === 0 && (ledger.pending ?? []).length > 0) {
        ledger.resolved_pending = [
          ...(ledger.resolved_pending ?? []),
          ...ledger.pending.map((item) => ({ ...item, resolved_by: runId, resolved_at: finishedAt.toISOString() })),
        ];
        ledger.pending = [];
      }

      ledger.verification.push({
        at: finishedAt.toISOString(),
        run_id: runId,
        gate: gateName,
        command: `npm run ${gateName}`,
        exit_code: gateExit,
        duration_ms: Date.now() - startedMs,
        mechanism: 'evaluator',
        steps: stepResults,
      });

      // STATE-MODEL, same conditional: the commit-bound record of what was judged. `evaluations[]` is additive and
      // non-causal, joins `verification[]` by `run_id`, and is read by no decision path. The record is what a reader
      // consults to tell a result for commit A from a result for commit B.
      try {
        appendEvaluation(
          ledger,
          buildEvaluationEntry({
            at: finishedAt.toISOString(),
            runId,
            task,
            gateName,
            workspacePath,
            pre: judgedPre,
            post: judgedPost,
          }),
        );

        // C3: the environment record is appended under EXACTLY the same conditional as `evaluations[]` — a gate-bearing,
        // gate-compatible, ledger-attached run. The design proposed a relaxed condition (including install failures and
        // `--no-gate`), but relaxing it would break `E1-04`/`E2-02`, which assert a `--no-gate` run leaves the ledger
        // BYTE-IDENTICAL; editing those assertions to accommodate a new field is exactly the gate weakening the counting
        // rule exists to prevent. So the relaxed case is served by the `environment_observed` run event and the
        // workspace attestation, never by the ledger.
        appendEnvironment(
          ledger,
          buildEnvironmentEntry({
            ...environmentInput,
            at: finishedAt.toISOString(),
            runId,
            gateBearing: true,
            resolverProbe: gateResolverProbe,
            resolverProbeRan: true,
            judgedCommit: judgedPost.commit ?? judgedPre.commit,
          }),
        );
      } catch (error) {
        fail(error.message);
      }
    }

    if (claim !== null && !(ledger.claims ?? []).some((entry) => entry.text === claim)) {
      ledger.claims = [...(ledger.claims ?? []), { at: startedAt.toISOString(), text: claim, source: 'agent' }];
    }

    if (derivedFailure !== null) {
      ledger.failures.push({
        at: finishedAt.toISOString(),
        category: derivedFailure,
        source: failure !== null ? 'human' : gateIncompatible ? 'gate_compatibility' : 'gate',
        note: typeof flags.notes === 'string' ? flags.notes : null,
      });
    }

    mutateLedger(ledger, DEFAULT_FS, { expectedDigest: ledgerBaseDigest });

    writer.emit('ledger_updated', {
      run_id: runId,
      ledger_run_id: ledger.run_id,
      ledger_status: ledger.status,
      verification_entries: ledger.verification.length,
      pending_open: ledger.pending.length,
      claims: ledger.claims.length,
    });
  }

  // THE SCOPE, COMPUTED IN-PROCESS. `GATES` is a module-local constant and the canonical step list is recorded nowhere
  // durable, so this is the only place a FULL_GATE can honestly be recognised: an external re-derivation would have to
  // hardcode what `check:fast` omits, which is the duplication that rots. `stepsTotal` is `GATES[gateName].length` — the
  // gate's OWN step count, not the number that happened to run — which is the field that was missing from the run
  // stream entirely and the reason `check` and `check:fast` were indistinguishable.
  const verdictScope = evaluateVerdictScope({
    runGate,
    gateIncompatible,
    stepMode,
    stepState: stepScope?.state ?? null,
    stepsRun: stepResults.length,
    stepsTotal: steps.length,
    gateName,
  });
  const verdictValue = evaluateVerdictValue(verdictScope, stepScope !== null ? stepExitCode : gateExit);
  // The memory. Grouped by the state THIS run judged, read from the run streams already on disk — zero extra gate
  // executions, which is what makes this a projection rather than a repeat-N engine.
  const priorObservations = priorObservationsForState({
    judgedCommit: judgedPre.commit,
    contractDigestValue: contractless ? null : contractDigest(task, gateName),
    sourceStatusHash: judgedPre.sourceStatusHash,
    gateName: runGate ? gateName : null,
    stepName: requestedStep,
    excludeRunId: runId,
  });

  const summary = {
    runId,
    eventsPath,
    logPath,
    runGate,
    gateName,
    gateExit,
    abortedAfter,
    stepResults,
    mechanicallyVerified,
    claim,
    acceptance: acceptanceVerdict,
    acceptanceSource,
    acceptanceCoverage: acceptanceAuto === null ? null : acceptanceAuto.coverage,
    acceptanceCoverageState: acceptanceAuto === null ? null : acceptanceAuto.coverage_state,
    acceptanceUncovered: acceptanceAuto === null ? null : acceptanceAuto.uncovered_criteria,
    verifier,
    blockedReason,
    failure: derivedFailure,
    workspace,
    metrics: collectRuntimeMetrics(flags),
    gateCompatibility: runGate ? (gateIncompatible ? 'gate_incompatible' : 'gate_compatible') : null,
    ledgerRunId: ledger === null ? null : ledger.run_id,
    ledgerStatus,
    // Additive summary fields. `null`/absent on every whole-gate run, so the ordinary report is unchanged.
    stepScope,
    stepExitCode,
    stepsTotal: steps.length,
    // Commit binding, rendered at the moment of decision. DISPLAY ONLY: no status, no exit code, no enum, no schema
    // change, no classifier input (C5).
    judgedCommitPre: judgedPre.commit,
    judgedCommitPost: judgedPost.commit,
    judgedCommitScope: judgedPre.scope,
    declaredSourceCommit: task.source_commit,
    // Additive, and the two facts a consumer needs that the run stream did not carry at all.
    gateBearing: runGate && !gateIncompatible,
    verdictScope,
    verdictValue,
    priorObservations,
    contractless,
  };

  printEvaluationSummary(summary);

  // THE MACHINE VERDICT. Printed after the human summary so `--json` output is never interleaved with prose, and it
  // is a PROJECTION: the run stream above is still the durable record, and this is disposable. Its first three fields
  // are `schema`, `verdict` and `scope`, in that order, deliberately — `judged_commit` and `declared_source_commit` are
  // in the HEAD of this object, which is the point of the whole projection: an agent that reads only the head still
  // learns WHAT was judged, not only that something was.
  //
  // "THE HEAD" IS AN ORDERED PREFIX, NOT A FIXED NUMBER OF BYTES — the previous comment here said "inside the first 200
  // bytes", which was false for two of the six fields it went on to name, and the same false sentence was published in
  // `AGENTS.md` and `.harness/README.md` (F-1). The order is the contract; the byte positions are a consequence of the
  // values. See `VERDICT_HEAD_FIELDS` and `verdictHeadByteFloor()`: seven keys cannot fit in 200 bytes under any values,
  // which is why the two commit fields sit at ~207 and ~275 in a real run and why the head is documented as "the first
  // nine keys, the whole head inside the first ~350 bytes" instead of as a byte count nobody can honour.
  if (flags.json === true) {
    const verdict = {
      schema: VERDICT_SCHEMA,
      verdict: verdictValue,
      scope: verdictScope,
      // THE FIELD ORDER IS PART OF THE CONTRACT, and it is `VERDICT_HEAD_FIELDS`, in this order. Six things are here, at
      // the top, because each of them was found being missed: (1) `run_id` and `measured_at`, because a SAVED verdict
      // for the same commit used to be byte-identical in its head to a fresh one — `judged_commit` matched HEAD, which is
      // exactly the check an agent reaches for first and which therefore CONFIRMED the stale read instead of challenging
      // it. With a measurement timestamp in the head, freshness is decidable from the head alone. (2) `judged_commit` and
      // `declared_source_commit`, for the reason Experiment F forced: a run whose judged commit differs from the
      // declared baseline is not a statement about that baseline, and the fact used to sit at byte ~2 200.
      // (3) `judged_source_status_hash` and `commits_since_source`, because a clean tree and an UNCOMMITTED edit at
      // the same commit produced the same head and the same `judged_commit` — the whole test-manipulation surface,
      // invisible on the machine surface. (4) What (1)+(2)+(3) cost: the head is ~330 bytes rather than 200, which is a
      // REPORTED trade with a computed floor (`verdictHeadByteFloor()`), not an accident and not a byte count to hit.
      run_id: runId,
      measured_at: measuredAt,
      judged_commit: judgedPre.commit,
      declared_source_commit: task.source_commit,
      judged_source_status_hash: judgedPre.sourceStatusHash,
      commits_since_source: state.commitsSinceSource,
      gate_bearing: summary.gateBearing,
      steps_run: stepResults.length,
      steps_total: steps.length,
      // Explicit `null` whenever no gate step ran: `--no-gate`, a per-step run's UNDEFINED step, and
      // `gate_incompatible`. `0` is the one number that would silently read as a pass, and a `gate_incompatible` run
      // used to report it (B1).
      gate_exit_code: evaluatedGateExitCode({ stepScope, stepExitCode, runGate, gateIncompatible, gateExit }),
      aborted_after: abortedAfter,
      gate: runGate ? gateName : null,
      step: stepScope === null ? null : stepScope.requested,
      step_state: stepScope?.state ?? null,
      failure_category: derivedFailure,
      contract_digest: contractless ? null : contractDigest(task, gateName),
      contractless,
      steps: stepResults.map((step) => ({ step: step.step, exit_code: step.exit_code })),
      acceptance: {
        verdict: acceptanceVerdict,
        source: acceptanceSource,
        // `seeded: true` means `contract init` generated the `acceptance` list from the task title and no human
        // asserted it. A seed is not a criterion, so an `unknown` beside it is not a missing verdict — it is the
        // correct verdict about a criterion that does not exist. Additive, null on a contractless run and on a
        // hand-written contract, and it changes no acceptance semantics.
        seeded: task.seeded_acceptance === true,
        coverage: acceptanceAuto === null ? null : acceptanceAuto.coverage,
        uncovered: acceptanceAuto === null ? null : acceptanceAuto.uncovered_criteria,
      },
      environment: verdictEnvironment(environmentRecord, gateEnvPolicy),
      prior_observations: priorObservations,
      events: relative(eventsPath),
    };

    // COMPACT, deliberately. This is a machine surface and the human summary is printed immediately above it;
    // indentation is whitespace a consumer pays for and reads nothing from. The measured size is part of the design
    // target (a projection of a ~19 640-byte evidence surface down to ~1.5 kB), and pretty-printing would double it
    // for formatting no consumer of a machine surface asked for.
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  }

  if (!runGate) {
    return 1;
  }

  // A PASSING PER-STEP RUN NOW EXITS 0. This is the ONE row of the exit protocol whose meaning changed, and it changed
  // because two states of the SAME measurement cannot share a code: a passing `--step` used to exit 1, so "my step
  // passed" and "my step failed" were indistinguishable by exit code alone. The scope is what keeps a 0 from being
  // read as a whole-gate claim — it is `SINGLE_STEP`, never `FULL_GATE`, and it is in the printed summary, in the
  // verdict, and in the run stream. A per-step run still derives NO terminal state, still leaves the ledger
  // byte-identical, and still reports `mechanically_verified: no`. An UNDEFINED step still exits 1: nothing ran, so
  // there is no pass to report. `regress` and `census` do not read the child's exit code — they read the run stream —
  // so no side classification changes.
  if (stepMode) {
    return stepScope.state === 'UNDEFINED' ? 1 : stepExitCode === 0 ? 0 : 1;
  }

  if (ledger !== null) {
    if (gateIncompatible) {
      return 3;
    }

    return ledgerStatus === 'verified' ? 0 : 1;
  }

  // Durable-state behavior: a verifier FAIL or a changed artifact is a non-success outcome even when the gate passed — a green gate
  // and a human acceptance pass cannot override independent evidence (invariant B).
  if (verifier !== null && verifier.verdict === 'FAIL') {
    return 1;
  }

  if (verifier !== null && verifier.artifact_integrity === 'CHANGED') {
    return 1;
  }

  // Exit 0 on mechanical verification, or on an explicitly recorded human acceptance pass (legacy semantics).
  if (mechanicallyVerified || acceptanceFlag === 'pass') {
    return 0;
  }

  return gateIncompatible ? 3 : 1;
}

function resolveGateName(flags, task) {
  const raw = flags.gate ?? task.verification?.gate ?? DEFAULT_GATE;

  if (!Object.hasOwn(GATES, raw)) {
    fail(`unknown gate "${raw}" — valid: ${Object.keys(GATES).join(', ')}`);
  }

  return raw;
}

function deriveFailure(exitCode, stepResults) {
  if (exitCode === 0 && stepResults.length > 0) {
    return null;
  }

  const failed = [...stepResults].reverse().find((s) => s.exit_code !== 0);

  if (!failed) {
    return exitCode === 0 ? null : 'unclassified';
  }

  const step = GATES.check.concat(GATES['check:full']).find((s) => s.step === failed.step);

  return step?.category ?? 'unclassified';
}

/**
 * The declared/judged mismatch, computed once for the summary. The comparison target is the contract THIS run judged by
 * (the same pairing the `evaluations[]` entry uses), never the ledger's frozen `source_commit`. A declared value may be a
 * short prefix, so a prefix match counts as agreement.
 */
function judgedCommitMismatch(summary) {
  const judged = summary.judgedCommitPre ?? summary.judgedCommitPost ?? null;
  const declared = typeof summary.declaredSourceCommit === 'string' ? summary.declaredSourceCommit : null;

  if (judged === null || declared === null) {
    return null;
  }

  return judged.startsWith(declared) ? null : { judged, declared };
}

/** `pre`, or `pre (moved during the gate: post)` when the two observations differ, plus the tree's scope. */
function judgedCommitLine(summary) {
  const primary = summary.judgedCommitPre ?? summary.judgedCommitPost ?? 'not observed';
  const moved =
    summary.judgedCommitPre !== null &&
    summary.judgedCommitPre !== undefined &&
    summary.judgedCommitPost !== null &&
    summary.judgedCommitPost !== undefined &&
    summary.judgedCommitPre !== summary.judgedCommitPost;

  return `${primary}${moved ? ` (moved during the gate: ${summary.judgedCommitPost})` : ''}${
    summary.judgedCommitScope ? ` [${summary.judgedCommitScope}]` : ''
  }`;
}

/** Display only. It changes no status, no exit code and no durable field. */
function judgedCommitWarning(summary) {
  const mismatch = judgedCommitMismatch(summary);

  return mismatch === null
    ? null
    : `WARNING:              judged commit ${mismatch.judged} differs from declared source_commit ${mismatch.declared} — this result is not a statement about ${mismatch.declared}`;
}

/**
 * A4 — the gate's own stdout is DATA, never a field of this harness's report.
 *
 * It used to be written raw, immediately above the real summary, so a commit whose `test` script printed
 * `VERDICT: PASS` / `mechanically_verified: yes` / `terminal result: 'verified` / `gate exit: 0` had those four
 * lines rendered as the FIRST FOUR LINES of the harness's own report — directly above the harness's real
 * `mechanically_verified: yes`. A reader scanning the top of the output, or a grep for `mechanically_verified:`,
 * saw the forged value first and the true value second. The `regress` JSON artifact was already safe (it parses, and
 * the forged text survives only as an escaped string value), so this was the terminal surface only.
 *
 * Two defences, because a fence alone is a convention and a prefix is a property: the tail is wrapped in an explicit
 * BEGIN/END block naming the step it came from, AND every line inside it is prefixed with a pipe. A forged
 * `mechanically_verified: yes` therefore renders as `| mechanically_verified: yes`, which is not a harness field
 * line by any parser, human or machine. The text is left otherwise verbatim — this is a presentation boundary, not
 * an escaping of the gate's words.
 */
/**
 * THE MACHINE-SURFACE CONTRACT, stated once so the code, the docs and a grep-and-parse consumer cannot disagree.
 *
 * 1. The machine surface is the LAST line of stdout and nothing else. `evaluate --json` prints the human summary, then
 *    the fence for each gate step as it happens, then exactly ONE line of JSON. No sentinel, no channel, no marker: a
 *    consumer takes the last line, and a producer cannot append to it.
 * 2. The literal schema token `harness.evaluate.verdict/1` appears on that line and NOWHERE ELSE on stdout. The fence
 *    neutralises it inside gate output, so `grep -m1 'harness.evaluate.verdict/1'` can only ever reach the real
 *    verdict. Before this, the fence defeated LINE-PREFIX matching (`| mechanically_verified: yes` is not a harness
 *    field line) but a forged `{"schema":"harness.evaluate.verdict/1",...,"verdict":"GATE_PASS"}` inside gate output
 *    was still the FIRST grep hit on a genuinely failing run — a consumer got `GATE_PASS / gate_exit_code: 0` while
 *    the real verdict was `GATE_FAIL` and the process exited 1.
 * 3. The token is NEUTRALISED, not escaped, because the threat is a substring search, not a JSON parser: a forged
 *    object is already unparseable here (every fenced line is `| `-prefixed), but `grep` does not care. A consumer
 *    who deliberately decodes the neutralised form back to the literal is outside this contract and is documented as
 *    such — this is a presentation boundary, never a claim that gate output can be made trustworthy.
 */
const MACHINE_SURFACE_BASIS =
  'The `--json` machine surface is the LAST line of stdout and nothing else, and the literal token `harness.evaluate.verdict/1` appears on that line ONLY: gate output is fenced with a `| ` prefix on every line AND has the token itself neutralised, so a grep-and-parse consumer cannot reach a forged verdict object before the real one. Neutralisation is a presentation boundary, not an authenticity claim: a consumer who deliberately reverses it is outside this contract, and gate output remains data this harness never vouches for.';

/** The one substitution the fence makes. Exported so the self-test can assert it without duplicating the rule. */
function neutraliseVerdictToken(line) {
  return line.split(VERDICT_SCHEMA).join(VERDICT_SCHEMA_NEUTRALISED);
}

function gateOutputFence(outputTail, { index, step, total, perStep = false }) {
  const label = `gate step ${index + 1}/${total} (${step}) — the lines below are the GATE's own output, verbatim. They are not this harness's fields and are never read as its verdict.${
    perStep
      ? ' PER-STEP MODE: this is ONE named step of the gate, run independently with no fail-fast; the other steps were not run and are not reported here as passing or failing.'
      : ''
  }`;
  const body = outputTail
    .split('\n')
    .map((line) => `| ${neutraliseVerdictToken(line)}`)
    .join('\n');

  return `${['--- begin ' + label, body, `--- end ${label}`].join('\n')}\n`;
}

function printEvaluationSummary(summary) {
  const lines = [
    '',
    `run_id:                ${summary.runId}`,
    `events:                ${relative(summary.eventsPath)}`,
    summary.runGate
      ? `gate log:              ${relative(summary.logPath)}`
      : 'gate:                  skipped (--no-gate)',
    `gate:                  ${summary.runGate ? summary.gateName : '-'}`,
    `steps run:             ${summary.stepResults.length}${typeof summary.stepsTotal === 'number' ? ` of ${summary.stepsTotal}` : ''}`,
    // B1. This line used to print `0` for a `gate_incompatible` run — the gate was REQUESTED, no step ran, and `0`
    // is the one number that reads as a pass. It now names the situation, which is the only thing that is true.
    `gate exit:             ${summary.stepScope ? (summary.stepScope.state === 'UNDEFINED' ? 'not run — the named step is UNDEFINED here' : summary.stepExitCode) : summary.runGate ? (summary.gateCompatibility === 'gate_incompatible' ? 'not run — the gate is gate_incompatible here, so NO STEP RAN (this is a SETUP failure, not a pass)' : summary.gateExit) : '-'}${summary.abortedAfter ? ` (aborted after ${summary.abortedAfter})` : ''}`,
    `mechanically_verified: ${summary.mechanicallyVerified ? 'yes' : 'no'}`,
    // The SCOPE, as a field and not as prose. This is Experiment E's fix in the HUMAN surface too: `check` and
    // `check:fast` both printed "steps run: N of N / gate exit: 0 / mechanically_verified: yes / failure category: none"
    // at the same exit code, and only the gate-name string told them apart. A PASS must never be readable as "the
    // project validates" unless the whole canonical gate is what passed.
    // The WORD, on its own line and with nothing after it, so a consumer that matches `^verdict: <value>$` keeps
    // working; the explanation is the next line rather than a suffix on this one. Two surfaces describing one run
    // must not be able to disagree, and a decorated value is how they start to.
    `verdict:              ${summary.verdictValue ?? '(not computed)'}`,
    // B2. A subset pass is NOT a whole-gate pass, and the word now says so; the line below says why, in words a
    // human reads, without touching the machine-readable value above.
    summary.verdictScope === 'SUBSET_GATE'
      ? 'verdict means:       a real gate passed, but it is a STRICT SUBSET of the canonical "check" gate. This is NOT ' +
        'whole-project validation, and the verdict word is deliberately not GATE_PASS.'
      : summary.verdictScope === 'FULL_GATE'
        ? 'verdict means:       the whole canonical "check" gate ran and every step exited 0 — this IS whole-project validation'
        : null,
    `scope:                ${summary.verdictScope ?? '(not computed)'}${
      summary.verdictScope === 'SUBSET_GATE'
        ? ' — a real gate passed, but it is a STRICT SUBSET of the canonical "check" gate; this is NOT whole-project validation'
        : summary.verdictScope === 'PARTIAL_FAIL_FAST'
          ? ' — the gate stopped at the first failing step, so the steps after it were NOT measured'
          : ''
    }`,
    `gate_bearing:         ${summary.gateBearing === true ? 'yes — a gate ran and produced a result' : 'no'}`,
    `gate compatibility:    ${summary.gateCompatibility ?? '-'}`,
    `ledger:                ${summary.ledgerRunId === null ? 'not attached' : summary.ledgerRunId}`,
    `judged commit:         ${judgedCommitLine(summary)}`,
    // Per-step mode. Printed ONLY when the flag was used, so an ordinary run's report is byte-identical to before.
    ...(summary.stepScope
      ? [
          `step mode:             single_step — ONE named step of gate "${summary.stepScope.gate}", run independently`,
          `step requested:        ${summary.stepScope.requested} (step ${summary.stepScope.step_position + 1} of ${summary.stepScope.step_total} in this build's gate definition)`,
          `step state:            ${summary.stepScope.state}${summary.stepScope.reason === null ? '' : ` — ${summary.stepScope.reason}: ${summary.stepScope.detail}`}`,
          `step command:          ${summary.stepScope.command ?? 'none — nothing was spawned'}`,
          `step manifest:         ${summary.stepScope.package_path === null ? 'not resolved' : `${summary.stepScope.package_path} script "${summary.stepScope.script}" = ${JSON.stringify(summary.stepScope.script_value)}`}`,
          `step fail-fast:        ${summary.stepScope.fail_fast} — ${summary.stepScope.fail_fast_basis}`,
          `UNDEFINED means:       ${summary.stepScope.state === 'UNDEFINED' ? summary.stepScope.undefined_basis : 'not applicable on this run (the step is runnable) and printed here so the meaning is never discovered only on the run that hits it'}`,
          `step ledger effect:    ${summary.stepScope.ledger_effect}`,
          'terminal result:         NONE. A per-step run derives no terminal state: one step is not the gate, no new exit code was minted for this mode, and the attached ledger is left byte-identical. A per-step run that PASSED exits 0, and that 0 is a statement about THIS STEP only — the scope above says SINGLE_STEP, never FULL_GATE, and mechanically_verified stays `no` because the gate was not verified.',
        ]
      : []),
    // A GATE-BEARING run with no ledger attached used to print "no-gate evaluation produced no terminal result" — a
    // false statement about a run that had just executed a 5-step gate, printed two lines below
    // "mechanically_verified: yes". An agent reads the word "no-gate" and concludes no gate ran. The old condition was
    // `ledgerStatus === null` ALONE, so it fired whether or not a gate had run. It is now split by `runGate`: the
    // `--no-gate` sentence is still exactly true for a `--no-gate` run, and a gate-bearing run gets a sentence that
    // says what actually happened instead of a phrase borrowed from the other case.
    summary.ledgerStatus === null
      ? summary.stepScope
        ? null
        : summary.gateBearing === true
          ? 'terminal result:         NONE — the gate DID run (see "gate exit:" and "steps run:" above); no ledger was attached, so this run derived no terminal state'
          : summary.runGate
            ? 'terminal result:         NONE — the gate was REQUESTED but is gate_incompatible here, so NO STEP RAN (see "gate compatibility:" above); that is a setup failure, not a result'
            : 'terminal result:         no-gate evaluation produced no terminal result'
      : null,
    judgedCommitWarning(summary),
    `agent claimed done:    ${summary.claim !== null ? 'yes' : 'no'}`,
    `acceptance:            ${summary.acceptance}`,
    `acceptance coverage:   ${
      summary.acceptanceCoverage === null
        ? 'not mechanically evaluated'
        : `${summary.acceptanceCoverageState} (${summary.acceptanceCoverage}${
            (summary.acceptanceUncovered ?? []).length > 0
              ? `; uncovered criteria: ${summary.acceptanceUncovered.join(', ')}`
              : ''
          })`
    }`,
    `verifier:              ${
      summary.verifier === null
        ? 'not run (recorded as no verifier evidence)'
        : `${summary.verifier.verdict} (artifact_integrity=${summary.verifier.artifact_integrity})`
    }`,
    summary.blockedReason === null ? null : `blocked reason:        ${summary.blockedReason}`,
    `false_done:            ${
      summary.claim === null
        ? 'n/a — NO claim was made, so there is no claim that could have been falsely done. This is null, not `no`; a confident `no` would be a statement about a tree nobody claimed anything about.'
        : summary.acceptance === undefined || summary.acceptance === 'unknown'
          ? 'n/a — acceptance is `unknown` (no criterion was ever judged; a SEEDED acceptance list stays `unknown` until a human writes real criteria), so "was this falsely claimed done?" was never asked. This is null, not `no`; a confident `no` would be a verdict about a criterion nobody wrote.'
          : !summary.mechanicallyVerified && summary.gateCompatibility !== 'gate_incompatible'
            ? 'YES — a completion claim was made and the gate did not mechanically verify'
            : 'no — a completion claim was made and the gate mechanically verified'
    }`,
    `failure category:      ${summary.failure ?? 'none'}`,
    // The memory, in one line, on every run. It ASSERTS NOTHING: it is a count of prior runs of THIS judged state and
    // the distinct exit codes they produced. `contradicted: true` is a fact about the history, not a verdict about
    // this run, and it resolves nothing in either direction — it exists so that "maybe this failure is flaky" is
    // available as DATA before an agent concludes its change is broken.
    `prior observations:   ${
      summary.priorObservations === undefined
        ? '(not recorded)'
        : summary.priorObservations.n === 0
          ? '0 — this judged state has not been run before'
          : summary.priorObservations.n === 1
            ? // n=1 used to read "those prior runs agreed with each other". ONE run cannot agree with anything; the
              // sentence described corroboration that did not exist, and it is the sentence a reader would trust.
              `1 prior run of this exact judged state; exit code [${summary.priorObservations.distinct_gate_exit_codes.join(', ')}] — ONE run cannot agree or disagree with anything, so this is history, not corroboration`
            : `${summary.priorObservations.n} prior runs of this exact judged state; exit codes [${summary.priorObservations.distinct_gate_exit_codes.join(', ')}]${summary.priorObservations.contradicted ? '; CONTRADICTED — those prior runs disagreed with each other' : '; those prior runs recorded the SAME exit code — an observation about the history, NOT a stability claim and not evidence that the predicate is deterministic'}`
    }${summary.priorObservations === undefined || summary.priorObservations.n === 0 ? '' : `\nprior observations caveat: ${summary.priorObservations.caveat_code} — ${summary.priorObservations.caveat}`}`,
    `files changed:         ${summary.workspace.files.length}${summary.workspace.truncated ? ' (truncated list)' : ''}`,
    // A contractless run has no declared source commit, so there is no diff base and the empty diffstat is not
    // evidence of "no change" — saying so would be a false statement about a run that never computed one.
    `diffstat:              ${
      summary.declaredSourceCommit === null
        ? '(not computed — no contract was attached, so there is no declared source commit to diff against; "judged commit:" above and the run stream say what WAS judged)'
        : summary.workspace.diffstat || '(no change vs source commit)'
    }`,
    `runtime metrics:       ${
      Object.keys(summary.metrics).length === 0
        ? 'unavailable (not exposed by the runtime)'
        : JSON.stringify(summary.metrics)
    }`,
    '',
  ];

  process.stdout.write(`${lines.filter((line) => line !== null).join('\n')}\n`);
}

// ---------------------------------------------------------------- gate compatibility

/**
 * Resolve which package.json must declare the npm script a gate step runs.
 * `readPackage` is supplied by the caller so the same logic works against a filesystem workspace
 * and against a git commit (`git show <sha>:package.json`).
 */
function gateStepScript(step) {
  if (step.command !== 'npm') {
    return null;
  }

  // `npm run <script> [flags]` or `npm <script> [flags]` (e.g. `npm test --workspace=…`).
  const script = step.args[0] === 'run' ? step.args[1] : step.args[0];

  if (script === undefined || script.startsWith('--')) {
    return null;
  }
  const wsArg = step.args.find((arg) => arg.startsWith('--workspace='));
  const dir = wsArg ? WORKSPACE_DIRS[wsArg.slice('--workspace='.length)] : null;

  return { script, packagePath: dir ? `${dir}/package.json` : 'package.json' };
}

/**
 * ONE gate-compatibility question: would TODAY'S gate definition find its scripts in the named manifest?
 *
 * `evaluate` and `validate` used to answer two different questions under one name — `evaluate` read the manifests on
 * disk through an inline closure, `validate` read a commit's manifests, and a third, dead helper duplicated the first
 * again. The question is the same; only the manifest differs, so the manifest is now named explicitly at the call site
 * and there is a single implementation. `validate`'s exit 0 on a gate-incompatible contract is a documented reporting
 * surface and is deliberately left alone.
 */
function gateCompatibility(gateName, source) {
  const readPackage = (packagePath) => {
    if (source.kind === 'commit') {
      const raw = git(['show', `${source.commit}:${packagePath}`]);

      if (raw === null) {
        return null;
      }

      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    const absolute = join(source.path, packagePath);

    if (!existsSync(absolute)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(absolute, 'utf8'));
    } catch {
      return null;
    }
  };

  return checkGateCompatibility(gateName, readPackage);
}

function checkGateCompatibility(gateName, readPackage) {
  const problems = [];
  const checked = [];

  for (const step of GATES[gateName]) {
    const target = gateStepScript(step);

    if (target === null) {
      problems.push(`${step.step}: unsupported step command`);
      continue;
    }

    if (checked.includes(target.packagePath)) {
      continue;
    }

    checked.push(target.packagePath);

    const pkg = readPackage(target.packagePath);

    if (pkg === null) {
      problems.push(`${step.step}: ${target.packagePath} not found`);
      continue;
    }

    if (pkg.scripts === undefined || pkg.scripts[target.script] === undefined) {
      problems.push(`${step.step}: ${target.packagePath} has no "${target.script}" script`);
    }
  }

  return { problems, checked };
}

// ---------------------------------------------------------------- per-step evaluation mode
//
// WHY A FLAG AND NOT A NEW SUBCOMMAND. The CLI is one `switch` over command names, and `evaluate` is a single ~700-line
// body that already owns the run stream, the gate log writer, the environment observation, the judged-tree samples, the
// ledger attachment and the exit protocol. A predicate-style `harness step` would have to reach all of that; reaching it
// by CALLING `evaluate` is the only way to avoid a second implementation, and a second implementation of a provenance
// path is exactly what this program is not allowed to grow. `--step=<name>` is therefore a flag ON `evaluate`, beside
// `--gate` and `--workspace`, and it selects WHICH STEPS the existing loop runs. There is one gate loop, one
// `runStep`, one pair of run-stream events and one provenance format, before and after.
//
// NO FAIL-FAST, AND NOT BY ACCIDENT. The gate loop is fail-fast with a `break`, which is correct for a conjunction and
// wrong for a census: a `check` gate that fails at `test:server` leaves `test:ui` and the build steps unmeasured, and
// per-step history is then unrecoverable from the record. Naming a step runs a ONE-ELEMENT loop, so there is nothing
// after it to skip: `step_scope.fail_fast` is recorded `false` because the loop held one step to begin with, not
// because the break was disabled.
//
// UNDEFINED IS A DISTINCT OUTCOME AND IS NEVER A FAIL. A step whose npm script the JUDGED commit's own manifests do
// not declare has no command to run: `npm run <script>` against such a workspace exits non-zero, and reporting that
// exit code as a step failure would manufacture a FAIL out of the absence of a declaration. Absence of evidence is
// not evidence of absence, so nothing runs, `step_scope.state` is `UNDEFINED`, `gate_exit_code` is `null`, and a side
// measured this way is INCONCLUSIVE — never PASS, never FAIL, and never a direction.
const STEP_MODE_FLAG = 'step';
/** The only two states a named step can reach before anything is spawned. Deliberately two, and neither is `fail`. */
const STEP_SCOPE_STATES = ['runnable', 'UNDEFINED'];
const STEP_SCOPE_UNDEFINED_BASIS = `UNDEFINED means the JUDGED workspace's own manifests do not declare the npm script this step runs: no gate ran, no command was spawned, no exit code exists, and the record carries an explicit null. UNDEFINED is NOT a failure and never becomes one — not in the step's exit code, not in the side classification, and not in a direction. It is the same distinction the compatibility census already draws between "the gate is gate_incompatible" (a refusal to judge) and "the commit's manifests do not declare this script" (nothing to judge), kept separate here because a census that conflated them would report a historical commit as red for scripts it never had.`;
const STEP_SCOPE_FAIL_FAST_BASIS =
  'a per-step run holds ONE step, so there is no later step a fail-fast could have skipped. The gate loop is not modified: the same loop, the same runStep, the same run-stream events and the same provenance record run over a one-element step list.';
/** What a per-step run does NOT do, recorded in the run itself rather than only in the manual. */
const STEP_SCOPE_LEDGER_EFFECT =
  'a per-step run does NOT update the attached ledger: no verification[] entry, no evaluations[] entry, no environments[] entry and no status change. One step is not the gate, and a terminal state derived from a single step would be a whole-gate claim this run did not measure. The run stream and the environment observation still record the step and its provenance, and the ledger is left byte-identical.';

// ---------------------------------------------------------------- the evaluate verdict (change 3)
//
// A PROJECTION of the summary object `evaluate` already holds, in a versioned shape. It is not a new tier of evidence
// and it is not a new record: the run stream is still written in full, and deleting the verdict loses nothing. It
// exists because the decision was unreachable — the five decision fields serialised to 157 bytes of a 19 640-byte
// evidence surface (1.03% of the stream), scattered across 41 sibling keys, and two facts a consumer NEEDS were not
// written anywhere at all.
//
// THOSE TWO FACTS. `gate_bearing` (did a gate actually run and produce a result) and `steps_total` (how many steps the
// gate has) did not exist in the run stream. Their absence is what made Experiment E possible: `check` printed
// "steps run: 5 of 5 / gate exit: 0 / mechanically_verified: yes / failure category: none" and `check:fast` printed
// "steps run: 3 of 3 / gate exit: 0 / mechanically_verified: yes / failure category: none" — IDENTICAL decision strings,
// IDENTICAL exit code, no marker. Both were individually true. Together they were a trap.
//
// `scope` is therefore mandatory, and it is computed IN-PROCESS. `GATES` is a module-local constant and the canonical
// step list is recorded nowhere durable, so a consumer re-deriving scope from the stream would have to hardcode what
// `check:fast` omits — the exact duplication that rots. The design's own first prototype tried that and silently
// labelled a `--no-gate` run `FULL_GATE` with "steps 0/0"; that is how the `steps_total` hole was found.
const VERDICT_SCHEMA = 'harness.evaluate.verdict/1';

/**
 * THE HEAD OF THE VERDICT IS AN ORDERED LIST OF KEYS, NOT A 200-BYTE WINDOW. This constant and the prose around the
 * verdict construction replaced a claim that was simply false.
 *
 * The claim was that "the first 200 bytes" carry six named fields. Measured on this tree, four of the six started inside
 * 200 and the other two sat at ~207 and ~275. The claim was not a near miss: a seven-key head CANNOT fit in 200 bytes under
 * ANY assignment of values, and `verdictHeadByteFloor()` computes exactly why. A seven-key JSON object prefix with every
 * value EMPTY is 112 bytes of key text, colons, commas, braces and value quotes; the two 40-hex commits add 80; that is
 * 192 bytes before `verdict`, `scope`, `run_id` and `measured_at` contribute a single byte, leaving 8 bytes for all four
 * combined — and `schema`'s own value is 28 bytes on its own, so filling in `schema` ALONE takes the head to 218. So the
 * old five-key head was already at the boundary (measured 206 with real values) and adding `run_id` and `measured_at` is
 * what broke it.
 *
 * THE TRADE WAS RIGHT AND THE PROSE WAS WRONG. A saved verdict whose head is byte-identical to a fresh one CONFIRMS the
 * stale reading — `judged_commit` matched HEAD, which is the first check an agent reaches for — while a commit name a few
 * dozen bytes later is still on the same line of the same object. Freshness won; the documentation is corrected here and
 * in `AGENTS.md`, `.harness/README.md` and `.harness/docs/schemas.md` to say WHAT IS TRUE: the head is this ordered prefix,
 * the whole head is inside the first ~350 bytes of every run, and 200 is not a boundary this format can honour.
 *
 * Nothing about the verdict's CONTENT changed and nothing was weakened to hit a byte count: the fields stay, in this
 * order, at the front of the object.
 */
const VERDICT_HEAD_FIELDS = [
  'schema',
  'verdict',
  'scope',
  'run_id',
  'measured_at',
  'judged_commit',
  'declared_source_commit',
  'judged_source_status_hash',
  'commits_since_source',
];

/**
 * The unconditional arithmetic behind the sentence above, COMPUTED rather than remembered, so the documents that quote
 * these numbers are quoting this program. `unavoidable` is what a seven-key head costs before `verdict`, `scope`, `run_id`
 * and `measured_at` contribute any value at all; `budgetLeft` is what is left of a 200-byte window for those four.
 */
function verdictHeadByteFloor() {
  const seven = VERDICT_HEAD_FIELDS.slice(0, 7);
  // Every value EMPTY: the cheapest legal JSON for these seven keys, so nothing here can be argued down.
  const emptyPrefix = `{${seven.map((key) => `${JSON.stringify(key)}:""`).join(',')}`;
  const commitValues = 2 * 40;
  const unavoidable = emptyPrefix.length + commitValues;
  // With EVERY value still empty the head is 192 bytes, i.e. 8 bytes of headroom — and `schema`'s own value is 28 bytes
  // including its quotes. Filling in `schema` ALONE therefore takes it to 218, so no seven-key head ever fits: the
  // overshoot is unconditional and it is not a matter of choosing shorter ids or timestamps.
  const withSchemaOnly = emptyPrefix.length - 2 + JSON.stringify(VERDICT_SCHEMA).length + commitValues;

  return {
    keys: seven.length,
    emptyPrefix,
    emptyPrefixBytes: emptyPrefix.length,
    commitValues,
    unavoidable,
    budgetLeft: 200 - unavoidable,
    schemaValueBytes: JSON.stringify(VERDICT_SCHEMA).length,
    withSchemaOnly,
    overshootWithSchemaOnly: withSchemaOnly - 200,
  };
}

/**
 * The ONLY form the schema token is allowed to take inside fenced gate output: one character different, and chosen
 * so that a literal `grep 'harness.evaluate.verdict/1'` cannot match it. U+2215 DIVISION SLASH, not ASCII `/` — a
 * reader who spots the difference is being told the line is not a harness field, which is exactly what it is.
 */
const VERDICT_SCHEMA_NEUTRALISED = 'harness.evaluate.verdict\u22151';
/**
 * What the run actually covered. `FULL_GATE` means every step of the CANONICAL gate (`check`, the project's own
 * `npm run check`) ran and exited 0. `SUBSET_GATE` means a real gate ran and passed but is a strict subset of the
 * canonical one — the `check:fast` case, and the only reason `SUBSET_GATE` exists as a value rather than a comment.
 */
const VERDICT_SCOPES = [
  'FULL_GATE',
  'SUBSET_GATE',
  'SINGLE_STEP',
  'PARTIAL_FAIL_FAST',
  'UNDEFINED',
  'GATE_INCOMPATIBLE',
  'NO_GATE',
];
/**
 * The three words, deliberately three. `NOT_A_GATE_PASS` exists so "the step passed" and "the gate passed" cannot
 * collapse — and since the adversarial review, so "a SUBSET of the gate passed" cannot collapse into it either.
 *
 * `GATE_PASS` is RESERVED for `FULL_GATE`. That is not a naming preference; it is the fix for a measured false PASS.
 * On a tree whose UI tests fail, `evaluate --no-contract --gate=check:fast --json` exited 0 with
 * `verdict: GATE_PASS`, `scope: SUBSET_GATE`, `steps_run: 3`, `steps_total: 3`. `GATE_PASS` was field 2 and the exit
 * code was 0 — the two signals a hurried reader takes first — and only `scope` (field 3) and `steps_total` (field 8)
 * said otherwise. The word now matches the scope: a strict subset is `NOT_A_GATE_PASS`, exactly as a passing
 * `--step` and a `--no-gate` run already were.
 */
const VERDICT_VALUES = ['GATE_PASS', 'GATE_FAIL', 'NOT_A_GATE_PASS'];
/** The gate the project itself calls canonical. In-process, from `GATES`; never hardcoded as a step list. */
const CANONICAL_GATE = 'check';
const CANONICAL_STEP_COUNT = GATES[CANONICAL_GATE].length;

/**
 * The scope of one run, as a PURE function of what the run did.
 *
 * Deliberately ordered, and the order is the argument: the narrowest question is answered first. A per-step run is
 * `SINGLE_STEP` whatever else is true, because one step is not a gate and no later rule may relabel it. An UNDEFINED
 * step is `UNDEFINED`, never `SINGLE_STEP` and never a failure — nothing was spawned, so there is no result to scope.
 * A `gate_incompatible` run is its own value, because it printed `gate exit: 0` next to `steps run: 0 of 5` at process
 * exit 3: each line true, jointly misleading. `PARTIAL_FAIL_FAST` is a run that stopped early, which is a real
 * measurement of a real prefix and NOT a pass over the whole gate.
 */
function evaluateVerdictScope({ runGate, gateIncompatible, stepMode, stepState, stepsRun, stepsTotal, gateName }) {
  if (stepMode) {
    return stepState === 'UNDEFINED' ? 'UNDEFINED' : 'SINGLE_STEP';
  }

  if (!runGate) {
    return 'NO_GATE';
  }

  if (gateIncompatible) {
    return 'GATE_INCOMPATIBLE';
  }

  if (stepsRun < stepsTotal) {
    return 'PARTIAL_FAIL_FAST';
  }

  // A pass over a strict subset of the canonical gate is a SUBSET_GATE, never a FULL_GATE. This is the whole of
  // Experiment E, expressed as one comparison against a constant that lives next to the gate definition.
  return gateName === CANONICAL_GATE && stepsTotal === CANONICAL_STEP_COUNT ? 'FULL_GATE' : 'SUBSET_GATE';
}

/**
 * THE ONE-WORD VERDICT — the word a skimmer reads first, and the field that had to change.
 *
 * `GATE_PASS` is emitted for a `FULL_GATE` run at exit 0 and for nothing else. A `SUBSET_GATE` pass is
 * `NOT_A_GATE_PASS`, and a `SINGLE_STEP` pass was already `NOT_A_GATE_PASS`; the exit code for both is 0, and the
 * scope, `gate_bearing` and `steps_total` are what distinguish a subset pass from a whole-gate pass. `GATE_FAIL` is
 * deliberately still emitted for a FAILING subset gate and for a `PARTIAL_FAIL_FAST` run: a failure cannot be misread
 * as a pass, so suppressing the word would lose information and buy nothing. `SINGLE_STEP`, `UNDEFINED`,
 * `GATE_INCOMPATIBLE` and `NO_GATE` are all `NOT_A_GATE_PASS` — none of them ran the gate, and `GATE_INCOMPATIBLE`
 * additionally reports `gate_exit_code: null` because no step ran (see `evaluatedGateExitCode`).
 */
function evaluateVerdictValue(scope, gateExitCode) {
  if (scope === 'FULL_GATE') {
    return gateExitCode === 0 ? 'GATE_PASS' : 'GATE_FAIL';
  }

  if (scope === 'SUBSET_GATE' || scope === 'PARTIAL_FAIL_FAST') {
    return gateExitCode === 0 ? 'NOT_A_GATE_PASS' : 'GATE_FAIL';
  }

  return 'NOT_A_GATE_PASS';
}

/**
 * The exit code of the GATE, or `null` when no gate step ran. Never `0` for "nothing ran".
 *
 * `gateExit` is initialised to `0` before the loop, so a `gate_incompatible` run — which exits 3, prints
 * `steps run: 0 of 5`, and spawns nothing — used to record `gate_exit_code: 0`. Every line was individually true and
 * the field was a false number: a consumer branching on `gate_exit_code === 0` concluded the gate passed on a run
 * where it never ran. An UNDEFINED step already reported an explicit `null` for exactly this reason (nothing was
 * spawned, so there is no exit code); this is the whole-gate half of the same rule, and the two now share one
 * function so they cannot drift.
 */
function evaluatedGateExitCode({ stepScope, stepExitCode, runGate, gateIncompatible, gateExit }) {
  if (stepScope !== null) {
    return stepExitCode;
  }

  return runGate && !gateIncompatible ? gateExit : null;
}

// ---------------------------------------------------------------- the evaluate exit table (change 4)
//
// `--help` documented the exit sets of `workspace`, `regress` and `census` in detail and never documented `evaluate`'s
// own. Two of its rows were indefensible as written:
//
//   a PASSING `--step` exited 1, so an agent could not distinguish "my step passed" from "my step failed" by exit code;
//   `evaluate` with no `--task` exited 1 while `ledger` with no `--task` exited 2 — two codes for one class of error.
//
// The first is changed here, from 1 to 0, and it is the ONLY row of this protocol whose meaning changed. It is changed
// because a pass and a failure of the SAME measurement cannot share an exit code; the scope is what keeps a 0 from
// being read as a whole-gate claim, and `scope: SINGLE_STEP` is printed on the same run and is the first field of the
// verdict. The `regress` and `census` exit sets are untouched, and `3` is still never emitted by any of the three.
//
// The table is ONE constant. `--help` prints it and the exit site is documented against it, so the help text and the
// code cannot drift into disagreeing about what a number means.
const EVALUATE_EXIT_TABLE = [
  [
    '0',
    'a gate-bearing run whose steps ALL exited 0 — the VERDICT WORD is GATE_PASS only for the canonical whole gate',
    'FULL_GATE or SUBSET_GATE; only FULL_GATE reads GATE_PASS, a SUBSET_GATE pass reads NOT_A_GATE_PASS',
  ],
  ['0', 'a single named step (`--step=<name>`) that PASSED', 'SINGLE_STEP → NOT_A_GATE_PASS — one step, not the gate'],
  [
    '1',
    'a gate-bearing run with a step that exited non-zero',
    'FULL_GATE or SUBSET_GATE or PARTIAL_FAIL_FAST → GATE_FAIL',
  ],
  ['1', 'a single named step that FAILED, or one that is UNDEFINED (nothing was spawned)', 'SINGLE_STEP / UNDEFINED'],
  ['1', '`--no-gate`, or a ledger-attached run whose derived status is not `verified`', 'NO_GATE'],
  [
    '2',
    'a refusal BEFORE anything was measured: unknown flag, a value-flag given WITHOUT a value, unknown step name, unusable `--fingerprint` tier, unusable `--gate-env` policy, a stray positional',
    'no run stream was written',
  ],
  [
    '3',
    '`gate_incompatible`: the gate cannot resolve in this workspace, so this is a SETUP failure and not an agent failure; `gate_exit_code` is an explicit null because no step ran',
    'GATE_INCOMPATIBLE — no step ran',
  ],
];
/** Why the table exists and why one row moved, in the words the table and `--help` both carry. */
const EVALUATE_EXIT_BASIS =
  'The exit protocol keeps its MEANING: 0 means the thing that ran, passed. It does not gain a code and it loses none. Exactly one row changed meaning, and it changed because two states of the SAME measurement cannot share a code: a passing `--step` used to exit 1, so "my step passed" and "my step failed" were indistinguishable by exit code alone. It now exits 0, and the scope — SINGLE_STEP, never FULL_GATE — travels on the same run in the printed summary and as the first field of the `--json` verdict, so a 0 from a one-step run can never be read as a whole-gate pass. A per-step run still derives NO terminal state, still leaves the ledger byte-identical, and still reports mechanically_verified: no.' +
  'THE SAME CLAIM NOW HOLDS FOR A SUBSET GATE, AND IT DID NOT BEFORE. `--gate=check:fast` on a tree whose UI tests fail exits 0 with `scope: SUBSET_GATE`, and the old verdict word was `GATE_PASS` — field 2 of the verdict, beside a 0 — so the two signals a hurried reader takes first were both green while the project did not validate. The word is now `NOT_A_GATE_PASS` for every scope that is not the canonical whole gate, so the first thing a reader sees and the exit code agree, for `--step` and for `--gate=check:fast` alike. A GATE_INCOMPATIBLE run additionally reports `gate_exit_code: null`, never 0, because no step ran.' +
  'Every refusal now exits 2 uniformly, before anything is measured: unknown flag, unknown step name, a bare value-flag such as `--ledger` with no `=value`, an unusable --fingerprint tier or --gate-env policy, a stray positional, a missing --task. The earlier sentence claiming that `evaluate` with no --task exits 1 described a build that no longer exists and is corrected here rather than left as a stale claim; the refusal text still names the missing flag.';

// ---------------------------------------------------------------- prior observations (change 6)
//
// "Maybe this failure is flaky" is not available as data today, and every input it needs is ALREADY on disk. A flaky
// predicate at one commit produced 16 run streams whose `gate_exit_code` values were {0, 1}; a grep of every one for
// flak|variab|unstable|intermitt|repeat|replicat matched exactly one line, and it was prose about `npm_config_*`
// VARIABLEs. `report` aggregates runs and never joins runs of the same commit. The contrast is one `readdirSync` away
// and nothing performs it.
//
// WHAT THIS ASSERTS: nothing. No rate, no bound, no exchangeability claim, and the words "stable", "confirmed" and
// "reproducible" appear in neither the field names nor the basis string. It says exactly one thing: these prior runs of
// this exact judged state disagreed. An agent that sees `contradicted: true` before its fifth consecutive red test does
// not conclude "my change is broken", and that is the entire value.
//
// THE KEY, AND TWO CORRECTIONS MEASURED INTO IT. (1) It reads `run_started.judged_commit` and
// `run_started.contract_digest`, NOT `run_finished` — those are null on some records, and keying on them collapsed
// distinct states into one group (measured: `distinct keys: 8` where cleaner grouping was correct). (2) It also carries
// `status_hash_pre`, or a DIRTY working tree with an unchanged commit joins two genuinely different states.
/**
 * THE CAVEAT AS A SIBLING OF THE BOOLEAN, not as a paragraph somewhere else.
 *
 * `prior_observations.contradicted` is a boolean, and the whole order-coupling residual — everything that stops
 * `contradicted: false` from meaning "this predicate is stable" — lived in a ~1 100-character `basis` string at byte
 * ~1 104 of the same object. A consumer reading FIELDS, which is the machine surface, therefore read an unqualified
 * `contradicted: false` and nothing else. A doc sentence would not have fixed it either: the reader this protects
 * against is not reading the docs.
 *
 * So the caveat is a field, at the front of the object, short enough to be read, and named by a stable code. It is
 * deliberately NOT a test-edit detector and it does not read as one: it makes no claim about the tree, about any
 * edit, or about masking, and no test-edit or masking classifier is built anywhere (the design rejected one and the
 * adversarial review agreed the rejection is sound). It says one thing — this is history, not corroboration, and it
 * cannot see an order-coupled defect.
 */
const PRIOR_OBSERVATIONS_CAVEAT_CODE = 'history_not_corroboration_order_coupling_unobservable';
const PRIOR_OBSERVATIONS_CAVEAT =
  'history, not corroboration: contradicted:false means no disagreement was OBSERVED in readable prior runs; at n<2 one run cannot disagree. Not a stability claim and not a test-edit detector.';
/**
 * SHORT ON PURPOSE, and the reason is measured rather than stylistic. The machine surface has a byte budget: E26-04
 * asserts the verdict stays under 2 500 bytes AND under a third of the evidence stream, and `prior_observations.basis`
 * alone was 1 138 of them. A 1 100-character caveat beside a 1 100-character basis would have blown that budget and
 * taught every future reader that the projection is unbounded. What a consumer needs here is a branchable code and
 * one sentence, so that is what the verdict carries; the long form lives here, in `--help` and in `.harness/docs`.
 */
const PRIOR_OBSERVATIONS_CAVEAT_BASIS =
  'The caveat that qualifies `contradicted` is a SIBLING FIELD, not only prose in `basis` at byte ~1104. A consumer reading fields — which is what a machine surface is for — was getting an unqualified `contradicted: false` with the entire residual 900 bytes away. `caveat_code` is a stable enum so a consumer can branch on it without string-matching prose, and `caveat` is one sentence, because the verdict has a measured byte budget (E26-04: under 2 500 bytes and under a third of the run stream) and a 1 100-character caveat would have exceeded it. It asserts nothing and it is not a test-edit, masking or test-manipulation classifier; none is built. The full prose is this constant, `--help` and `.harness/docs/schemas.md`.';

const PRIOR_OBSERVATIONS_BASIS =
  'A count of prior runs of THIS exact judged state, their distinct gate exit codes, and whether they disagreed. It asserts no rate, no bound, no exchangeability assumption and no guarantee. Keyed on run_started (judged_commit, contract_digest, judged_source_status_hash, gate, step). WHAT IT CANNOT SEPARATE, the residual the interleaved repeat schedule has: a defect coupled to trial-index parity, to the absolute order of gate executions in a session, or to a one-shot resource stays consistent across every prior run and cannot be told from a real difference. A memory, not a verdict: it resolves nothing in either direction.';
/** How many run streams one `evaluate` will read. Bounded so a large history cannot tax the common path. */
const PRIOR_OBSERVATIONS_MAX_STREAMS = 500;

/**
 * One run stream, or `null` if it cannot be read whole.
 *
 * A truncated or partially-written stream is NOT evidence about anything, and it is not a reason to fail a run: the
 * caller of this is a memory lookup, and a memory lookup must never be able to turn a gate run into an error. `null`
 * means "nothing here", which the grouping already handles.
 */
function readRunStream(path) {
  try {
    return parseJsonlStrict(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** JSONL → objects, or a throw if ANY line is unparseable. Never partially: a half-read stream is a whole miss. */
function parseJsonlStrict(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * The grouping key. `run_started` ONLY, for the reason in `PRIOR_OBSERVATIONS_BASIS`: the same three fields are on
 * `run_finished`, but null on some records, and a key built on a null collapses distinct states into one group.
 */
function priorObservationKey(started) {
  return canonicalJson([
    started.judged_commit ?? null,
    started.contract_digest ?? null,
    // `judged_source_status_hash`, and this is a MEASURED correction to keying on `status_hash_pre`. That field is a
    // digest of `git status --porcelain`, and `.harness/` is UNTRACKED here, so every run this program performs
    // writes a run stream and CHANGES it. Keying on it put every run of one commit in its own group and made the
    // memory permanently empty — verified on a disposable fixture, where four consecutive runs of ONE commit
    // produced four different `status_hash_pre` values. The grouping needs the same fact the design wanted (a dirty
    // tree at an unchanged commit is a different state) from a field that is a function of the judged SOURCE.
    started.judged_source_status_hash ?? null,
    started.gate ?? null,
    started.step_scope?.requested ?? null,
  ]);
}

/** `n`, the distinct exit codes, and whether they disagreed. A group of one is never `contradicted`. */
/**
 * The environment block of the verdict.
 *
 * This is EXPERIMENT D's fix. Tampering with `node_modules/.package-lock.json` changed `installed_state_digest` while
 * the judged commit stayed identical — the drift was DETECTED, and it was completely invisible: a grep for
 * environment|digest|node_modules|lockfile over the terminal summary returned NOTHING, and the 5 555-byte observation
 * existed only in the run stream. A drift between two runs of one commit is now two verdicts an agent can compare
 * directly, without opening either stream.
 *
 * A SELECTION, not a copy: the full record is 110 fields and stays where it is. What is here is what identifies the
 * environment a result depended on, and each digest keeps the basis string that says what it is not.
 */
function verdictEnvironment(entry, gateEnvPolicy) {
  const source = entry ?? {};
  const packageManager =
    source.package_manager?.name == null
      ? null
      : `${source.package_manager.name} ${source.package_manager.version ?? ''}`.trim();

  return {
    installed_state_digest: source.installed_state_digest ?? null,
    installed_state_digest_source: source.installed_state_digest_source ?? null,
    installed_state_digest_basis:
      "declared_by_npm: npm's own account of node_modules, not an independent observation of the bytes",
    installed_tree_fingerprint: source.installed_tree_fingerprint ?? null,
    installed_tree_fingerprint_tier: source.installed_tree_fingerprint_tier ?? null,
    build_state_digest: source.build_state?.digest ?? null,
    node: source.node?.version ?? null,
    package_manager: packageManager,
    platform: source.platform == null ? null : `${source.platform.os ?? '?'}/${source.platform.arch ?? '?'}`,
    env_vars_digest: source.env?.vars_digest ?? null,
    gate_env_policy: source.gate_env_policy ?? gateEnvPolicy ?? null,
  };
}

function summariseExitCodes(codes) {
  const distinct = [...new Set(codes)].sort((a, b) => a - b);

  return { n: codes.length, distinct_gate_exit_codes: distinct, contradicted: distinct.length > 1 };
}

/**
 * Prior runs of this exact judged state, read from `RUNS_DIR`. ZERO extra gate executions — every byte it reads was
 * written by an earlier run of this program, which is the whole reason this is a projection and not an engine.
 *
 * Returns `{ n: 0, contradicted: false }` for a state nothing has judged before. Never `contradicted: true`
 * vacuously: one observation cannot disagree with itself, and the empty group says so rather than implying a rate.
 */
function priorObservationsForState({
  judgedCommit,
  contractDigestValue,
  sourceStatusHash,
  gateName,
  stepName = null,
  excludeRunId = null,
}) {
  const wanted = priorObservationKey({
    judged_commit: judgedCommit,
    contract_digest: contractDigestValue,
    judged_source_status_hash: sourceStatusHash,
    gate: gateName,
    step_scope: stepName === null ? null : { requested: stepName },
  });
  const result = {
    ...summariseExitCodes([]),
    // The caveat leads the object, not the `basis` string at the end of it. See PRIOR_OBSERVATIONS_CAVEAT.
    caveat: PRIOR_OBSERVATIONS_CAVEAT,
    caveat_code: PRIOR_OBSERVATIONS_CAVEAT_CODE,
    by_step: {},
    streams_read: 0,
    streams_considered: 0,
    truncated: false,
    basis: PRIOR_OBSERVATIONS_BASIS,
  };

  if (!existsSync(RUNS_DIR)) {
    return result;
  }

  // Most recent first, so the bound below keeps the observations nearest to this run rather than the oldest history.
  const all = readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .reverse();
  const files = all.slice(0, PRIOR_OBSERVATIONS_MAX_STREAMS);

  result.streams_considered = files.length;
  result.truncated = all.length > files.length;

  const overall = [];
  const perStep = new Map();

  for (const name of files) {
    const events = readRunStream(join(RUNS_DIR, name));

    if (events === null) {
      continue;
    }

    result.streams_read += 1;

    const started = events.find((event) => event?.event === 'run_started');
    const finished = events.find((event) => event?.event === 'run_finished');

    if (started === undefined || finished === undefined) {
      continue;
    }

    if (excludeRunId !== null && finished.run_id === excludeRunId) {
      continue;
    }

    if (priorObservationKey(started) !== wanted) {
      continue;
    }

    // An UNDEFINED per-step run carries an explicit null exit code. It IS an observation of this state, so it is
    // counted, and it is not a CODE, so it stays out of the distinct-code list rather than being dropped from the group.
    overall.push(finished.gate_exit_code);

    for (const step of finished.steps ?? []) {
      if (typeof step?.step !== 'string' || typeof step?.exit_code !== 'number') {
        continue;
      }

      if (!perStep.has(step.step)) {
        perStep.set(step.step, []);
      }

      perStep.get(step.step).push(step.exit_code);
    }
  }

  return {
    // THE CAVEAT LEADS. `summariseExitCodes` supplies `contradicted`, so spreading it first would put the unqualified
    // boolean at field 3 with the caveat behind it — which is exactly the reviewer's complaint, in a smaller form: a
    // consumer reading the first few fields must not be able to reach `contradicted` without having passed the caveat.
    // Key insertion order is the JSON key order, so the order of these two lines IS the contract. The self-test and
    // E27-07 both assert it positionally, because a comment saying "leads" is not a property.
    caveat: PRIOR_OBSERVATIONS_CAVEAT,
    caveat_code: PRIOR_OBSERVATIONS_CAVEAT_CODE,
    ...summariseExitCodes(overall.filter((code) => typeof code === 'number')),
    by_step: Object.fromEntries([...perStep.entries()].map(([step, codes]) => [step, summariseExitCodes(codes)])),
    streams_read: result.streams_read,
    streams_considered: result.streams_considered,
    truncated: result.truncated,
    basis: PRIOR_OBSERVATIONS_BASIS,
  };
}

/** Read one manifest out of the workspace on disk. `null` for missing, unreadable or unparseable — never a guess. */
function readWorkspacePackage(workspacePath, packagePath) {
  const absolute = join(workspacePath, packagePath);

  if (!existsSync(absolute)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve ONE named step of a gate against the workspace it would run in.
 *
 * Three outcomes, and only two of them are states: an unknown step NAME is refused by name (a usage error, because
 * silently running the whole gate for a step that does not exist is the worst possible reading of a flag an operator
 * typed to narrow a measurement), a step whose script the manifests do not declare is `UNDEFINED`, and everything else
 * is `runnable`.
 */
function assertGateStepExists(gateName, stepName) {
  const steps = GATES[gateName] ?? [];

  if (!steps.some((candidate) => candidate.step === stepName)) {
    fail(
      `--step=${stepName} is not a step of gate "${gateName}" — its steps are: ${steps.map((candidate) => candidate.step).join(', ')}. A step that is not in the gate is refused BY NAME rather than answered with the whole gate, which would be the opposite of what the flag asked for.`,
    );
  }

  return steps;
}

function resolveStepScope(gateName, stepName, workspacePath) {
  const steps = assertGateStepExists(gateName, stepName);
  const step = steps.find((candidate) => candidate.step === stepName);

  const undefinedScope = (reason, detail) => ({
    mode: 'single_step',
    gate: gateName,
    requested: stepName,
    state: 'UNDEFINED',
    reason,
    detail,
    step_position: steps.findIndex((candidate) => candidate.step === stepName),
    step_total: steps.length,
    command: null,
    package_path: null,
    script: null,
    script_value: null,
    fail_fast: false,
    fail_fast_basis: STEP_SCOPE_FAIL_FAST_BASIS,
    undefined_basis: STEP_SCOPE_UNDEFINED_BASIS,
    ledger_effect: STEP_SCOPE_LEDGER_EFFECT,
    checked_in: recordedCwd(workspacePath),
  });
  const target = gateStepScript(step);

  if (target === null) {
    return undefinedScope(
      'unsupported_step_command',
      `step "${stepName}" of gate "${gateName}" does not run an npm script this harness build knows how to resolve, so there is no manifest to check and no command to run`,
    );
  }

  const pkg = readWorkspacePackage(workspacePath, target.packagePath);

  if (pkg === null) {
    return undefinedScope(
      'manifest_not_found_or_unreadable',
      `${target.packagePath} is absent or is not readable JSON in the workspace being judged, so it declares no "${target.script}" script`,
    );
  }

  if (pkg.scripts === undefined || pkg.scripts[target.script] === undefined) {
    return undefinedScope(
      'script_not_declared',
      `${target.packagePath} in the workspace being judged declares no "${target.script}" script`,
    );
  }

  return {
    mode: 'single_step',
    gate: gateName,
    requested: stepName,
    state: 'runnable',
    reason: null,
    detail: null,
    step_position: steps.findIndex((candidate) => candidate.step === stepName),
    step_total: steps.length,
    command: formatCommand(step),
    package_path: target.packagePath,
    script: target.script,
    script_value: String(pkg.scripts[target.script]),
    fail_fast: false,
    fail_fast_basis: STEP_SCOPE_FAIL_FAST_BASIS,
    undefined_basis: null,
    ledger_effect: STEP_SCOPE_LEDGER_EFFECT,
    checked_in: recordedCwd(workspacePath),
  };
}

/**
 * `evaluate --step=<name>`. The flag is validated here, before a single byte is written, because `parseFlags` has no
 * allowlist: an unknown flag is silently ignored, so a bare `--step` (a boolean, not a name) would otherwise be the
 * same command as no flag at all — a real capability requested and silently not granted.
 */
function resolveStepFlag(flags, gateName) {
  const raw = flags[STEP_MODE_FLAG];

  if (raw === undefined) {
    return null;
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(
      `evaluate --step requires the NAME of one step of gate "${gateName}" (--step=<name>), not a bare --step. This flag narrows a measurement, so an unnamed one is refused rather than treated as "no narrowing" and quietly run as the whole gate.`,
    );
  }

  if (flags['no-gate'] === true) {
    fail(
      `evaluate --step=${raw.trim()} and --no-gate contradict each other: one asks for exactly one step of the gate and the other asks for none. Neither can be honoured, so both are refused rather than one silently winning.`,
    );
  }

  // The NAME is checked against the gate definition here, once, so both callers refuse an unknown step before any
  // workspace is prepared or any install is spent. Whether the step is APPLICABLE is a different question and is
  // answered by `resolveStepScope` against the judged workspace's own manifests.
  assertGateStepExists(gateName, raw.trim());

  return raw.trim();
}

// ---------------------------------------------------------------- Durable-state behavior — verifier evidence

/**
 * Turn the command line into compact verifier evidence, or `null` when no verifier ran.
 *
 * Sources:
 *   --verifier-report=<path>   a JSON file in the Structural behavior/10 handoff shape (validated with handoff.mjs)
 *   --verifier-verdict=<v>     PASS | FAIL | BLOCKED
 *   --artifact-integrity=<s>   UNCHANGED | CHANGED | UNKNOWN
 *
 * A report supplies verdict/integrity/evidence; explicit flags may confirm or add, and a contradiction is refused rather
 * than resolved silently. Nothing here decides a ledger status — that is `classifyLedgerStatus`.
 */
function resolveVerifierEvidence(flags, runId, at) {
  const verdictFlag = typeof flags['verifier-verdict'] === 'string' ? flags['verifier-verdict'] : null;
  const integrityFlag = typeof flags['artifact-integrity'] === 'string' ? flags['artifact-integrity'] : null;
  const reportPath = typeof flags['verifier-report'] === 'string' ? flags['verifier-report'] : null;

  if (verdictFlag === null && integrityFlag === null && reportPath === null) {
    return null;
  }

  if (verdictFlag !== null && !VERIFIER_VERDICTS.includes(verdictFlag)) {
    fail(`--verifier-verdict must be one of: ${VERIFIER_VERDICTS.join(' | ')}`);
  }

  if (integrityFlag !== null && !ARTIFACT_INTEGRITY_STATES.includes(integrityFlag)) {
    fail(`--artifact-integrity must be one of: ${ARTIFACT_INTEGRITY_STATES.join(' | ')}`);
  }

  let report = null;

  if (reportPath !== null) {
    const absolute = resolve(REPO_ROOT, reportPath);

    if (!existsSync(absolute)) {
      fail(`--verifier-report file does not exist: ${absolute}`);
    }

    try {
      report = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch (error) {
      fail(`--verifier-report is not valid JSON: ${error.message}`);
    }

    // A handoff-shaped report is validated with the repository's own validator: the evidence channel is not allowed to
    // smuggle a transcript, and a verifier handoff must carry a verdict and an integrity observation.
    const looksLikeHandoff = typeof report === 'object' && report !== null && 'task_id' in report && 'role' in report;

    if (looksLikeHandoff) {
      const validated = validateHandoff(report);

      if (!validated.ok) {
        fail(`--verifier-report is not a valid handoff: ${validated.problems.join('; ')}`);
      }
    }
  }

  const reportVerdict = report === null ? null : (report.verdict ?? HANDOFF_STATUS_TO_VERDICT[report.status] ?? null);

  if (reportVerdict !== null && !VERIFIER_VERDICTS.includes(reportVerdict)) {
    fail(`--verifier-report carries an unusable verdict: ${reportVerdict}`);
  }

  if (verdictFlag !== null && reportVerdict !== null && verdictFlag !== reportVerdict) {
    fail(
      `--verifier-verdict=${verdictFlag} contradicts the report's verdict ${reportVerdict} — record one source, not two`,
    );
  }

  const reportIntegrity = report === null ? null : (report.artifact_integrity ?? null);

  if (integrityFlag !== null && reportIntegrity !== null && integrityFlag !== reportIntegrity) {
    fail(
      `--artifact-integrity=${integrityFlag} contradicts the report's artifact_integrity ${reportIntegrity} — record one source, not two`,
    );
  }

  const verdict = verdictFlag ?? reportVerdict;

  if (verdict === null) {
    fail(
      'a verifier report without a verdict cannot be recorded — supply --verifier-verdict or a report with `verdict`',
    );
  }

  // Integrity and human-acceptance behavior (INTEGRITY-PROVENANCE, 14B §3 C1/C2): an integrity observation is a DECLARATION unless it says it was computed, so it
  // must carry a bounded basis (who/how) and, optionally, the kind it claims. Fail-closed: no basis, no observation.
  const integrityBasis =
    typeof flags['artifact-integrity-basis'] === 'string' ? flags['artifact-integrity-basis'] : null;
  const integrityKindFlag =
    typeof flags['artifact-integrity-kind'] === 'string' ? flags['artifact-integrity-kind'] : null;

  if (integrityFlag !== null || reportIntegrity !== null) {
    if (integrityBasis === null || integrityBasis.trim() === '') {
      fail(
        'an artifact-integrity observation requires --artifact-integrity-basis (one bounded line: who/how it was produced)',
      );
    }

    if (integrityBasis.length > 400) {
      fail(`--artifact-integrity-basis is ${integrityBasis.length} chars (max 400)`);
    }

    if (integrityKindFlag !== null && !ARTIFACT_INTEGRITY_KINDS.includes(integrityKindFlag)) {
      fail(`--artifact-integrity-kind must be one of: ${ARTIFACT_INTEGRITY_KINDS.join(' | ')} (default: declared)`);
    }
  }

  return compactVerifier({
    verdict,
    artifactIntegrity: integrityFlag ?? reportIntegrity ?? 'UNKNOWN',
    artifactIntegrityBasis: integrityBasis,
    artifactIntegrityKind: integrityKindFlag,
    findings: report?.findings ?? [],
    criteriaChecked: report?.criteria_checked ?? [],
    evidence: [
      ...(Array.isArray(report?.evidence) ? report.evidence : []),
      ...(typeof flags['verifier-evidence'] === 'string' ? [flags['verifier-evidence']] : []),
    ],
    source: reportPath === null ? 'flags' : 'handoff',
    at,
    runId,
  });
}

const LEDGER_MAX_BYTES = 1_048_576;
const LEDGER_MAX_DEPTH = 32;
const FORENSIC_MAX_BYTES = 16_777_216;
const LEDGER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const LEDGER_GIT_HEX_RE = /^[0-9a-f]{7,40}$/;
const LEDGER_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const LEDGER_GATE_COMPATIBILITY = ['gate_compatible', 'gate_incompatible', null];
const LEDGER_WORK_SOURCES = ['agent', 'evaluator', 'human', 'gate', 'gate_compatibility'];
const LEDGER_FAILURE_SOURCES = ['agent', 'human', 'gate', 'gate_compatibility'];

function parseStrictJson(raw, options = {}) {
  const maxBytes = options.maxBytes ?? LEDGER_MAX_BYTES;
  const maxDepth = options.maxDepth ?? LEDGER_MAX_DEPTH;
  const rejectDuplicateKeys = options.rejectDuplicateKeys !== false;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const failWith = (code, detail) => ({ ok: false, code, detail });

  if (bytes.length > maxBytes) {
    return failWith('LEDGER_TOO_LARGE', `${bytes.length} bytes exceeds ${maxBytes}`);
  }

  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return failWith('LEDGER_INVALID_UTF8', 'input is not valid UTF-8');
  }

  let index = 0;
  let duplicateKey = null;

  const badJson = (detail) => {
    throw new Error(`LEDGER_INVALID_JSON:${detail}`);
  };
  const whitespace = () => {
    while (index < text.length && /[\x20\x09\x0a\x0d]/.test(text[index])) index += 1;
  };
  const stringValue = () => {
    const start = index;
    index += 1;

    while (index < text.length) {
      const code = text.charCodeAt(index);

      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          badJson('invalid string escape');
        }
      }

      if (code < 0x20) badJson('unescaped control character in string');
      if (code === 0x5c) {
        index += 2;
        continue;
      }
      index += 1;
    }

    badJson('unterminated string');
  };
  const numberValue = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);

    if (match === null || match[0].length === 0) badJson('invalid number');
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) badJson('non-finite number');
    return value;
  };
  const value = (depth) => {
    if (depth > maxDepth) throw new Error(`LEDGER_TOO_DEEP:${depth} exceeds ${maxDepth}`);
    whitespace();
    const char = text[index];

    if (char === '"') return stringValue();
    if (char === '{') return objectValue(depth + 1);
    if (char === '[') return arrayValue(depth + 1);
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    if (char === '-' || (char >= '0' && char <= '9')) return numberValue();
    badJson(`unexpected token at byte offset ${index}`);
  };
  const objectValue = (depth) => {
    const object = {};
    const keys = new Set();
    index += 1;
    whitespace();

    if (text[index] === '}') {
      index += 1;
      return object;
    }

    while (true) {
      whitespace();
      if (text[index] !== '"') badJson('object key must be a string');
      const key = stringValue();
      if (rejectDuplicateKeys && keys.has(key)) duplicateKey ??= key;
      keys.add(key);
      whitespace();
      if (text[index] !== ':') badJson('missing colon after object key');
      index += 1;
      object[key] = value(depth);
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return object;
      }
      if (text[index] !== ',') badJson('expected comma between object members');
      index += 1;
    }
  };
  const arrayValue = (depth) => {
    const array = [];
    index += 1;
    whitespace();

    if (text[index] === ']') {
      index += 1;
      return array;
    }

    while (true) {
      array.push(value(depth));
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return array;
      }
      if (text[index] !== ',') badJson('expected comma between array elements');
      index += 1;
    }
  };

  let parsed;

  try {
    parsed = value(0);
    whitespace();
    if (index !== text.length) badJson('trailing content');
  } catch (error) {
    const message = String(error?.message);
    if (message.startsWith('LEDGER_TOO_DEEP:')) {
      return failWith('LEDGER_TOO_DEEP', message.slice('LEDGER_TOO_DEEP:'.length));
    }
    if (message.startsWith('LEDGER_INVALID_JSON:')) {
      return failWith('LEDGER_INVALID_JSON', message.slice('LEDGER_INVALID_JSON:'.length));
    }
    throw error;
  }

  if (duplicateKey !== null) return failWith('LEDGER_DUPLICATE_KEY', `duplicate key ${JSON.stringify(duplicateKey)}`);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failWith('LEDGER_NOT_OBJECT', 'root JSON value must be an object');
  }

  return { ok: true, value: parsed };
}

function validateOperationalLedger(ledger) {
  const problems = [];
  const object = (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) problems.push(`${path} must be an object`);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  };
  const required = (value, key, path) => {
    if (!Object.hasOwn(value, key)) problems.push(`${path}.${key} is required`);
  };
  const text = (value, path, min = 1, max = Number.MAX_SAFE_INTEGER) =>
    typeof value !== 'string' || value.length < min || value.length > max
      ? problems.push(`${path} must be text(${min === 0 ? 0 : min}..${max})`)
      : undefined;
  const optText = (value, path, max) =>
    value !== null && (typeof value !== 'string' || value.length < 1 || value.length > max)
      ? problems.push(`${path} must be null or text(1..${max})`)
      : undefined;
  // A nullable hex observation: the writer normalises every optional observation to `null`, so the reader must accept
  // exactly that. Rejecting `null` here would make writer and reader disagree, and a disagreement bricks the ledger on
  // the NEXT read, not at write time.
  const optHex = (value, path, pattern, label) =>
    value !== null && (typeof value !== 'string' || !pattern.test(value))
      ? problems.push(`${path} must be null or ${label}`)
      : undefined;
  // A run id is a STRING matching the bounded token grammar. `RegExp.test` coerces its argument, so a bare
  // `.test` would accept `42`, `true` or `[]` as a token; the type is checked first, and `null` stays legal
  // where the field is declared `RunToken|null`. The evaluator only ever writes string run ids, so this
  // cannot make a ledger it wrote unreadable.
  const runToken = (value, path) =>
    typeof value !== 'string' || !LEDGER_TOKEN_RE.test(value) ? problems.push(`${path} must be a token`) : undefined;
  const optEnum = (value, path, allowed) =>
    value !== null && !allowed.includes(value)
      ? problems.push(`${path} must be null or ${allowed.map(String).join(' | ')}`)
      : undefined;
  const optPositiveInt = (value, path) =>
    value !== null && (!Number.isInteger(value) || value < 1)
      ? problems.push(`${path} must be null or a positive integer`)
      : undefined;
  const nonNegInt = (value, path) =>
    !Number.isInteger(value) || value < 0 ? problems.push(`${path} must be a non-negative integer`) : undefined;
  const unit = (value, path) =>
    value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      ? problems.push(`${path} must be null or a finite number from 0 through 1`)
      : undefined;
  const finiteNonNeg = (value, path) =>
    typeof value !== 'number' || !Number.isFinite(value) || value < 0
      ? problems.push(`${path} must be a finite number >= 0`)
      : undefined;
  const enumValue = (value, allowed, path) =>
    !allowed.includes(value) ? problems.push(`${path} must be one of ${allowed.map(String).join(' | ')}`) : undefined;
  const array = (value, path, min, max, validateItem) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
      problems.push(`${path} must be an array with ${min}..${max} items`);
      return;
    }
    value.forEach((item, index) => validateItem(item, `${path}[${index}]`));
  };
  /**
   * `null` ("this was not observed") is DISTINCT from `[]` ("this was observed, and the list is empty"). Collapsing them
   * would recreate F3 one level up: a field that says "nothing" when it means "unknown" is a false reason in a durable
   * record, and `[]` is exactly what a reader would read as an observation.
   */
  const nullableArray = (value, path, min, max, validateItem) => {
    if (value === null) {
      return;
    }
    array(value, path, min, max, validateItem);
  };
  const fields = (value, path, known) => {
    if (!object(value, path)) return;
    for (const [key, validate] of Object.entries(known)) {
      required(value, key, path);
      if (Object.hasOwn(value, key)) validate(value[key], `${path}.${key}`);
    }
  };
  const timestamp = (value, path) => {
    const match = typeof value === 'string' ? value.match(LEDGER_TIMESTAMP_RE) : null;
    if (match === null) {
      problems.push(`${path} must be YYYY-MM-DDTHH:mm:ss[.fraction]Z`);
      return;
    }
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const parsed = new Date(value);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day ||
      parsed.getUTCHours() !== hour ||
      parsed.getUTCMinutes() !== minute ||
      parsed.getUTCSeconds() !== second
    ) {
      problems.push(`${path} must be a valid UTC calendar timestamp`);
    }
  };
  const countMap = (value, path, maxKeys = 200) => {
    if (!object(value, path) || Object.keys(value).length > maxKeys) {
      problems.push(`${path} must be an object with at most ${maxKeys} keys`);
      return;
    }
    for (const [key, count] of Object.entries(value)) {
      text(key, `${path} key`, 1, 200);
      nonNegInt(count, `${path}.${key}`);
    }
  };
  const countTextMap = (value, path) => {
    if (value === null) return;
    if (!object(value, path) || Object.keys(value).length > 20) {
      problems.push(`${path} must be null or an object with at most 20 keys`);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      text(key, `${path} key`, 1, 200);
      text(entry, `${path}.${key}`, 1, 1000);
    }
  };
  const work = (value, path) =>
    fields(value, path, {
      at: timestamp,
      text: (entry, field) => text(entry, field, 1, 4000),
      source: (entry, field) => enumValue(entry, LEDGER_WORK_SOURCES, field),
    });
  const step = (value, path) =>
    fields(value, path, {
      step: (entry, field) => text(entry, field, 1, 120),
      command: (entry, field) => text(entry, field, 1, 2000),
      exit_code: (entry, field) =>
        !Number.isInteger(entry) || entry < 0 || entry > 255
          ? problems.push(`${field} must be an integer 0..255`)
          : undefined,
      duration_ms: finiteNonNeg,
    });
  const checkIssue = (value, path) =>
    fields(value, path, {
      id: (entry, field) => text(entry, field, 1, 200),
      detail: (entry, field) => text(entry, field, 1, 2000),
    });
  const criterion = (value, path) =>
    fields(value, path, {
      criterion: (entry, field) =>
        !Number.isInteger(entry) || entry < 1 ? problems.push(`${field} must be a positive integer`) : undefined,
      state: (entry, field) => enumValue(entry, ['covered_pass', 'covered_fail', 'covered_error', 'uncovered'], field),
      checks: (entry, field) => array(entry, field, 0, 100, (item, itemPath) => text(item, itemPath, 1, 200)),
      detail: (entry, field) => text(entry, field, 1, 2000),
    });
  const acceptanceChecks = (value, path) => {
    if (!object(value, path)) return;
    for (const key of [
      'verdict',
      'criteria_total',
      'criteria_covered',
      'coverage',
      'failed',
      'errored',
      'uncovered_criteria',
      'mechanism',
    ]) {
      required(value, key, path);
    }
    enumValue(value.verdict, ['pass', 'fail', 'unresolved'], `${path}.verdict`);
    nonNegInt(value.criteria_total, `${path}.criteria_total`);
    nonNegInt(value.criteria_covered, `${path}.criteria_covered`);
    unit(value.coverage, `${path}.coverage`);
    array(value.failed, `${path}.failed`, 0, 10_000, checkIssue);
    array(value.errored, `${path}.errored`, 0, 10_000, checkIssue);
    if (!Array.isArray(value.uncovered_criteria) || value.uncovered_criteria.length > 10_000) {
      problems.push(`${path}.uncovered_criteria must be an array with at most 10000 items`);
    } else {
      const seen = new Set();
      for (const [index, item] of value.uncovered_criteria.entries()) {
        if (!Number.isInteger(item) || item < 1 || seen.has(item))
          problems.push(`${path}.uncovered_criteria[${index}] must be a unique positive integer`);
        seen.add(item);
      }
    }
    enumValue(value.mechanism, ['mechanical'], `${path}.mechanism`);
    if (Object.hasOwn(value, 'criteria')) array(value.criteria, `${path}.criteria`, 0, 10_000, criterion);
    if (Object.hasOwn(value, 'coverage_state'))
      enumValue(value.coverage_state, ['covered', 'partial', 'uncovered'], `${path}.coverage_state`);
  };
  const humanAcceptance = (value, path) => {
    if (!object(value, path)) return;
    const known = new Set(['mechanism', 'authority', 'covered_criteria', 'basis', 'recorded_at']);
    for (const key of Object.keys(value)) if (!known.has(key)) problems.push(`${path}.${key} is unknown`);
    for (const key of known) required(value, key, path);
    enumValue(value.mechanism, ['human'], `${path}.mechanism`);
    text(value.authority, `${path}.authority`, 1, 200);
    text(value.basis, `${path}.basis`, 1, 400);
    timestamp(value.recorded_at, `${path}.recorded_at`);
    if (
      !Array.isArray(value.covered_criteria) ||
      value.covered_criteria.length < 1 ||
      value.covered_criteria.length > 500
    )
      problems.push(`${path}.covered_criteria must contain 1..500 indices`);
    else {
      const seen = new Set();
      for (const [index, item] of value.covered_criteria.entries()) {
        if (!Number.isInteger(item) || item < 1 || seen.has(item))
          problems.push(`${path}.covered_criteria[${index}] must be a unique positive integer`);
        seen.add(item);
      }
    }
  };
  const finding = (value, path) => {
    if (!object(value, path)) return;
    if (Object.hasOwn(value, 'text')) {
      text(value.text, `${path}.text`, 1, 400);
      return;
    }
    for (const key of ['requirement', 'mechanism', 'evidence']) {
      required(value, key, path);
      if (Object.hasOwn(value, key)) optText(value[key], `${path}.${key}`, 200);
    }
  };
  const verifier = (value, path) => {
    if (value === null || !object(value, path)) {
      if (value !== null) problems.push(`${path} must be null or an object`);
      return;
    }
    fields(value, path, {
      at: timestamp,
      run_id: (entry, field) =>
        entry !== null && !LEDGER_TOKEN_RE.test(entry) ? problems.push(`${field} must be null or a token`) : undefined,
      source: (entry, field) => enumValue(entry, ['handoff', 'flags', 'none'], field),
      verdict: (entry, field) => enumValue(entry, ['PASS', 'FAIL', 'BLOCKED'], field),
      artifact_integrity: (entry, field) => enumValue(entry, ['UNCHANGED', 'CHANGED', 'UNKNOWN'], field),
      artifact_integrity_basis: (entry, field) => optText(entry, field, 400),
      artifact_integrity_kind: (entry, field) => enumValue(entry, ['computed', 'declared'], field),
      criteria_checked: (entry, field) => array(entry, field, 0, 20, (item, itemPath) => text(item, itemPath, 1, 400)),
      findings: (entry, field) => array(entry, field, 0, 10, finding),
      evidence: (entry, field) => array(entry, field, 0, 10, (item, itemPath) => text(item, itemPath, 1, 400)),
      authority: (entry, field) => text(entry, field, 1, 400),
    });
  };
  const blocker = (value, path) => {
    if (!object(value, path)) return;
    for (const key of ['at', 'text', 'source']) required(value, key, path);
    timestamp(value.at, `${path}.at`);
    text(value.text, `${path}.text`, 1, 2000);
    enumValue(value.source, ['evaluator', 'agent'], `${path}.source`);
    if (Object.hasOwn(value, 'kind'))
      enumValue(value.kind, ['artifact_integrity_changed', 'acceptance_coverage_incomplete'], `${path}.kind`);
    if (Object.hasOwn(value, 'run_id') && value.run_id !== null && !LEDGER_TOKEN_RE.test(value.run_id))
      problems.push(`${path}.run_id must be null or a token`);
  };
  /**
   * One commit-bound evaluation record. Every field is required PRESENT (the writer always writes all of them) and every
   * observation — including `gate` — is nullable, because the writer normalises an absent, blank or over-long gate name
   * to `null` on write. The reader accepts exactly what the writer can emit: a reader that demanded more would reject a
   * ledger this evaluator itself wrote, and `loadLedger` fails closed, so the disagreement would brick it on the NEXT
   * read rather than at write time. This is a record of one invocation's observed tree state — it is NOT a reproduction
   * recipe and establishes neither reproducibility nor determinism, dependency fidelity, nor evaluator fidelity.
   */
  const evaluationEntry = (value, path) => {
    if (!object(value, path)) return;
    fields(value, path, {
      at: timestamp,
      run_id: (entry, field) => runToken(entry, field),
      declared_source_commit: (entry, field) =>
        optHex(entry, field, LEDGER_GIT_HEX_RE, '7..40 lower-case hex characters'),
      judged_commit_pre: (entry, field) => optHex(entry, field, JUDGED_COMMIT_RE, '40 lower-case hex characters'),
      judged_commit_post: (entry, field) => optHex(entry, field, JUDGED_COMMIT_RE, '40 lower-case hex characters'),
      judged_commit_basis: (entry, field) => enumValue(entry, JUDGED_COMMIT_BASES, field),
      judged_commit_scope: (entry, field) => optEnum(entry, field, JUDGED_COMMIT_SCOPES),
      judged_cwd: (entry, field) => optText(entry, field, 1024),
      status_hash_pre: (entry, field) => optHex(entry, field, DIGEST_12_RE, '12 lower-case hex characters'),
      status_hash_post: (entry, field) => optHex(entry, field, DIGEST_12_RE, '12 lower-case hex characters'),
      gate: (entry, field) => optText(entry, field, 120),
      gate_definition_sha256: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
      contract_digest: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
      lockfile_digest: (entry, field) => optHex(entry, field, DIGEST_12_RE, '12 lower-case hex characters'),
      acceptance_contract_schema_version: (entry, field) => optPositiveInt(entry, field),
    });
  };
  /**
   * One environment-provenance record. Same discipline as `evaluationEntry`: every field is present (the writer always
   * writes all of them) and every observation is nullable, because the writer normalises on write and the reader must
   * accept exactly what the writer can emit — a disagreement would brick the ledger on the NEXT read, not at write
   * time. A record never claims a dependency tree it did not look at: an unreadable field is `null`, never a default.
   */
  const environmentEntry = (value, path) => {
    if (!object(value, path)) return;
    const optBool = (entry, field) =>
      entry !== null && typeof entry !== 'boolean' ? problems.push(`${field} must be null or a boolean`) : undefined;
    const optionalInt = (entry, field) =>
      entry !== null && (!Number.isInteger(entry) || entry < 0)
        ? problems.push(`${field} must be null or a non-negative integer`)
        : undefined;
    const nullable = (shape) => (entry, field) => {
      if (entry === null) {
        return undefined;
      }

      if (typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${field} must be null or an object`);
        return undefined;
      }

      fields(entry, field, shape);
      return undefined;
    };
    fields(value, path, {
      at: timestamp,
      run_id: (entry, field) => runToken(entry, field),
      schema_version: (entry, field) => optPositiveInt(entry, field),
      gate_bearing: (entry, field) =>
        typeof entry !== 'boolean' ? problems.push(`${field} must be a boolean`) : undefined,
      declared_source_commit: (entry, field) =>
        optHex(entry, field, LEDGER_GIT_HEX_RE, '7..40 lower-case hex characters'),
      judged_commit: (entry, field) => optHex(entry, field, JUDGED_COMMIT_RE, '40 lower-case hex characters'),
      judged_commit_basis: (entry, field) => enumValue(entry, JUDGED_COMMIT_BASES, field),
      workspace_key: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
      workspace_instance: (entry, field) => optText(entry, field, 40),
      workspace_root_source: (entry, field) => optEnum(entry, field, WORKSPACE_ROOT_SOURCES),
      workspace_root_digest: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
      dependency_provisioning: (entry, field) => enumValue(entry, DEPENDENCY_PROVISIONING, field),
      dependency_provisioning_basis: (entry, field) => enumValue(entry, DEPENDENCY_PROVISIONING_BASES, field),
      node_modules_topology: (entry, field) => enumValue(entry, NODE_MODULES_TOPOLOGY, field),
      node_modules_scope: (entry, field) => enumValue(entry, NODE_MODULES_SCOPES, field),
      node_modules_realpath: (entry, field) => optText(entry, field, 1024),
      installed_package_count: optionalInt,
      installed_state_digest: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
      installed_state_digest_source: (entry, field) => optEnum(entry, field, INSTALLED_DIGEST_SOURCES),
      installed_tree_fingerprint: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
      installed_tree_fingerprint_tier: (entry, field) => optEnum(entry, field, TREE_FINGERPRINT_TIERS),
      installed_tree_fingerprint_limitation: (entry, field) => optText(entry, field, 600),
      installed_tree_fingerprint_basis: (entry, field) => optText(entry, field, 300),
      resolver_probe: (entry, field) => {
        // A bounded, capped probe: the reader refuses more than RESOLVER_PROBE_CAP entries, so a writer that grew the
        // cap would produce a ledger this very reader rejects on the next load.
        if (entry === null) {
          return undefined;
        }

        if (!Array.isArray(entry) || entry.length > RESOLVER_PROBE_CAP) {
          problems.push(`${field} must be null or an array with at most ${RESOLVER_PROBE_CAP} items`);
          return undefined;
        }

        for (const [index, item] of entry.entries()) {
          if (!object(item, `${field}[${index}]`)) {
            continue;
          }

          fields(item, `${field}[${index}]`, {
            name: (nested, nestedField) => text(nested, nestedField, 1, 200),
            resolved: (nested, nestedField) => optText(nested, nestedField, 1024),
          });
        }

        return undefined;
      },
      install: nullable({
        mode: (entry, field) => enumValue(entry, INSTALL_MODES, field),
        outcome: (entry, field) => enumValue(entry, INSTALL_OUTCOMES, field),
        exit_code: (entry, field) =>
          entry !== null && (!Number.isInteger(entry) || entry < 0 || entry > 255)
            ? problems.push(`${field} must be null or an integer 0..255`)
            : undefined,
        duration_ms: (entry, field) =>
          entry !== null && (!Number.isFinite(entry) || entry < 0)
            ? problems.push(`${field} must be null or a finite number >= 0`)
            : undefined,
        offline: optBool,
        output_tail: (entry, field) => optText(entry, field, 2000),
      }),
      package_manager: nullable({
        name: (entry, field) => optEnum(entry, field, PACKAGE_MANAGER_NAMES),
        version: (entry, field) => optText(entry, field, 64),
        resolved_from: (entry, field) => optEnum(entry, field, ['path_probe', 'package_manager_field', 'corepack']),
        declared_field: (entry, field) => optText(entry, field, 200),
        declared_field_honoured: optBool,
        declared_field_conflict: optBool,
      }),
      node: nullable({
        version: (entry, field) => optText(entry, field, 64),
        major: optionalInt,
        minor: optionalInt,
        patch: optionalInt,
        engines_node: (entry, field) => optText(entry, field, 200),
        engines_satisfied: optBool,
        engine_strict: optBool,
      }),
      platform: nullable({
        os: (entry, field) => optText(entry, field, 64),
        arch: (entry, field) => optText(entry, field, 64),
      }),
      env: nullable({
        vars_digest: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
        count: optionalInt,
        allowlist_digest: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
        allowlist_count: optionalInt,
        excluded_names: (entry, field) => array(entry, field, 0, 20, (item, itemPath) => text(item, itemPath, 1, 200)),
        excluded_digest: (entry, field) => optHex(entry, field, DIGEST_16_RE, '16 lower-case hex characters'),
        module_resolution_vars_removed: (entry, field) =>
          array(entry, field, 0, 10, (item, itemPath) => text(item, itemPath, 1, 200)),
        module_resolution_vars_accepted: (entry, field) =>
          array(entry, field, 0, 10, (item, itemPath) => text(item, itemPath, 1, 200)),
      }),
      resolver_probe_resolved_outside: (entry, field) =>
        nullableArray(entry, field, 0, RESOLVER_PROBE_CAP, (item, itemPath) => text(item, itemPath, 1, 200)),
      resolver_probe_resolved_nothing: (entry, field) =>
        nullableArray(entry, field, 0, RESOLVER_PROBE_CAP, (item, itemPath) => text(item, itemPath, 1, 200)),
      resolver_probe_all_inside_workspace: optBool,
      resolver_probe_negative_control: nullable({
        name: (entry, field) => text(entry, field, 1, 200),
        resolved: (entry, field) => optText(entry, field, 1024),
        observed: optBool,
        basis: (entry, field) => optText(entry, field, 300),
      }),
      // `null` or a boolean, and in practice ALWAYS `null` from this build: npm does not report whether a lifecycle
      // script ran, so the harness does not claim it did. The reader still accepts a boolean for a foreign writer.
      historical_install_executed_arbitrary_scripts: optBool,
      historical_install_script_execution_basis: (entry, field) => optText(entry, field, 400),
      historical_install_scripts_policy: (entry, field) =>
        optEnum(entry, field, [
          'not_applicable',
          'lifecycle_scripts_permitted',
          'scripts_suppressed_by_ignore_scripts',
        ]),
      historical_install_ignore_scripts: optBool,
      historical_install_output_showed_script_output: optBool,
      historical_install_output_basis: (entry, field) => optText(entry, field, 400),
      gate_env_policy: (entry, field) => optEnum(entry, field, GATE_ENV_POLICIES),
      primary_git_config_hooks_path_before: (entry, field) => optText(entry, field, 200),
      primary_git_config_hooks_path_after: (entry, field) => optText(entry, field, 200),
      primary_git_config_changed: optBool,
      deviation: (entry, field) => optText(entry, field, 400),
      bounded_reason: (entry, field) => optText(entry, field, 400),
    });
  };
  const legacyMessages = (value, path) => {
    if (!object(value, path)) return;
    countMap(value.kinds, `${path}.kinds`);
    countMap(value.tool_calls, `${path}.tool_calls`);
    nonNegInt(value.tool_calls_total, `${path}.tool_calls_total`);
    if (object(value.api_requests, `${path}.api_requests`)) {
      nonNegInt(value.api_requests.count, `${path}.api_requests.count`);
      for (const key of ['tokens_in', 'tokens_out', 'cache_reads', 'cache_writes', 'cost']) {
        if (typeof value.api_requests[key] !== 'number' || !Number.isFinite(value.api_requests[key]))
          problems.push(`${path}.api_requests.${key} must be finite`);
      }
      nonNegInt(value.api_requests.with_numbers, `${path}.api_requests.with_numbers`);
    }
    countMap(value.api_protocols, `${path}.api_protocols`);
    if (
      value.max_tokens_in_single_request !== null &&
      (typeof value.max_tokens_in_single_request !== 'number' || !Number.isFinite(value.max_tokens_in_single_request))
    )
      problems.push(`${path}.max_tokens_in_single_request must be null or finite`);
    nonNegInt(value.subtask_results_in_parent, `${path}.subtask_results_in_parent`);
    if (value.first_ts !== null) timestamp(value.first_ts, `${path}.first_ts`);
    if (value.last_ts !== null) timestamp(value.last_ts, `${path}.last_ts`);
    if (value.wall_clock_ms !== null) finiteNonNeg(value.wall_clock_ms, `${path}.wall_clock_ms`);
  };
  const v2Messages = (value, path) => {
    if (!object(value, path)) return;
    countMap(value.kinds, `${path}.kinds`);
    countMap(value.tool_calls, `${path}.tool_calls`);
    nonNegInt(value.tool_calls_total, `${path}.tool_calls_total`);
    if (object(value.api_requests, `${path}.api_requests`)) {
      for (const key of ['request_envelopes_enumerated', 'request_envelopes_parsed', 'request_envelopes_malformed'])
        nonNegInt(value.api_requests[key], `${path}.api_requests.${key}`);
      const metrics = value.api_requests.metrics;
      if (!object(metrics, `${path}.api_requests.metrics`))
        problems.push(`${path}.api_requests.metrics must be an object`);
      else
        for (const name of ['tokens_in', 'tokens_out', 'cache_reads', 'cache_writes', 'cost']) {
          if (!Object.hasOwn(metrics, name)) problems.push(`${path}.api_requests.metrics.${name} is required`);
          else metric(metrics[name], `${path}.api_requests.metrics.${name}`);
        }
    } else problems.push(`${path}.api_requests must be an object`);
    countMap(value.api_protocols, `${path}.api_protocols`);
    if (
      value.max_tokens_in_single_request !== null &&
      (typeof value.max_tokens_in_single_request !== 'number' || !Number.isFinite(value.max_tokens_in_single_request))
    )
      problems.push(`${path}.max_tokens_in_single_request must be null or finite`);
    nonNegInt(value.subtask_results_in_parent, `${path}.subtask_results_in_parent`);
    if (value.first_ts !== null) timestamp(value.first_ts, `${path}.first_ts`);
    if (value.last_ts !== null) timestamp(value.last_ts, `${path}.last_ts`);
    if (value.wall_clock_ms !== null) finiteNonNeg(value.wall_clock_ms, `${path}.wall_clock_ms`);
  };
  const telemetryV1 = (value, path) => {
    if (!object(value, path)) return;
    for (const key of ['status', 'reason', 'store_task_id', 'observed', 'derived', 'unavailable_metrics'])
      required(value, key, path);
    fields(value, path, {
      status: (entry, field) => enumValue(entry, ['observed', 'unavailable'], field),
      reason: (entry, field) => optText(entry, field, 400),
      store_task_id: (entry, field) => entry !== null && text(entry, field, 1, 200),
    });
    if (value.observed !== null) legacyMessages(value.observed, `${path}.observed`);
    if (value.derived !== null && object(value.derived, `${path}.derived`)) {
      unit(value.derived.cache_read_share_of_prompt_tokens, `${path}.derived.cache_read_share_of_prompt_tokens`);
      if (value.derived.mean_cost_per_request !== null)
        finiteNonNeg(value.derived.mean_cost_per_request, `${path}.derived.mean_cost_per_request`);
    }
    countTextMap(value.unavailable_metrics, `${path}.unavailable_metrics`);
  };
  const metric = (value, path) => {
    if (!object(value, path)) return;
    for (const key of ['total', 'mean', 'max']) {
      if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))
        problems.push(`${path}.${key} must be null or finite`);
    }
    if (object(value.source_metric_counts, `${path}.source_metric_counts`)) {
      for (const key of [
        'records_enumerated',
        'values_observed',
        'values_source_null',
        'values_not_recorded',
        'values_invalid',
      ])
        nonNegInt(value.source_metric_counts[key], `${path}.source_metric_counts.${key}`);
    } else problems.push(`${path}.source_metric_counts must be an object`);
  };
  const telemetryV2 = (value, path) => {
    if (!object(value, path)) return;
    for (const key of [
      'schema_version',
      'extracted_at',
      'store',
      'task_dir',
      'task_id',
      'files_present',
      'acquisition',
      'observed',
      'derived',
      'unavailable_metrics',
    ])
      required(value, key, path);
    if (value.schema_version !== 2) problems.push(`${path}.schema_version must be 2`);
    timestamp(value.extracted_at, `${path}.extracted_at`);
    text(value.store, `${path}.store`, 1, 4096);
    text(value.task_dir, `${path}.task_dir`, 1, 4096);
    if (!LEDGER_TOKEN_RE.test(value.task_id)) problems.push(`${path}.task_id must be a token`);
    if (object(value.files_present, `${path}.files_present`))
      for (const key of ['ui_messages', 'api_conversation_history', 'task_metadata'])
        if (typeof value.files_present[key] !== 'boolean')
          problems.push(`${path}.files_present.${key} must be boolean`);
    if (!object(value.acquisition, `${path}.acquisition`)) problems.push(`${path}.acquisition must be an object`);
    else if (value.acquisition.status === 'available') {
      if (value.acquisition.reason !== null) problems.push(`${path}.acquisition.reason must be null when available`);
    } else if (value.acquisition.status === 'unavailable') {
      text(value.acquisition.reason, `${path}.acquisition.reason`, 1, 400);
      if (value.observed !== null || value.derived !== null || value.unavailable_metrics !== null)
        problems.push(`${path} unavailable payload fields must be null`);
    } else problems.push(`${path}.acquisition.status must be available or unavailable`);
    if (value.observed !== null && object(value.observed, `${path}.observed`)) {
      v2Messages(value.observed.messages, `${path}.observed.messages`);
      if (
        value.observed.context_history !== null &&
        object(value.observed.context_history, `${path}.observed.context_history`)
      ) {
        for (const key of [
          'entries',
          'chars_total',
          'chars_first',
          'chars_max',
          'chars_mean',
          'entries_with_condense_parent',
        ])
          nonNegInt(value.observed.context_history[key], `${path}.observed.context_history.${key}`);
        if (value.observed.context_history.units !== 'characters (not tokens)')
          problems.push(`${path}.observed.context_history.units is invalid`);
      } else if (value.observed.context_history !== null)
        problems.push(`${path}.observed.context_history must be null or an object`);
      if (value.observed.context_files_tracked !== null)
        nonNegInt(value.observed.context_files_tracked, `${path}.observed.context_files_tracked`);
    } else if (value.observed !== null) problems.push(`${path}.observed must be null or an object`);
    if (value.derived !== null && object(value.derived, `${path}.derived`)) {
      unit(
        value.derived.cache_read_share_of_observed_prompt_tokens,
        `${path}.derived.cache_read_share_of_observed_prompt_tokens`,
      );
      if (value.derived.mean_cost_per_observed_cost_leaf !== null)
        finiteNonNeg(
          value.derived.mean_cost_per_observed_cost_leaf,
          `${path}.derived.mean_cost_per_observed_cost_leaf`,
        );
    }
    countTextMap(value.unavailable_metrics, `${path}.unavailable_metrics`);
  };
  const telemetryV2StoredSnapshot = (value, path) => {
    if (!object(value, path)) return;
    for (const key of ['schema_version', 'status', 'reason', 'observed', 'derived', 'unavailable_metrics'])
      required(value, key, path);
    if (value.schema_version !== 2) problems.push(`${path}.schema_version must be 2`);
    enumValue(value.status, ['available', 'unavailable'], `${path}.status`);
    if (value.status === 'available') {
      if (value.reason !== null) problems.push(`${path}.reason must be null when available`);
      if (!Object.hasOwn(value, 'store_task_id') || !LEDGER_TOKEN_RE.test(value.store_task_id))
        problems.push(`${path}.store_task_id must be a token when available`);
      v2Messages(value.observed, `${path}.observed`);
      if (value.derived !== null && object(value.derived, `${path}.derived`)) {
        unit(
          value.derived.cache_read_share_of_observed_prompt_tokens,
          `${path}.derived.cache_read_share_of_observed_prompt_tokens`,
        );
        if (value.derived.mean_cost_per_observed_cost_leaf !== null)
          finiteNonNeg(
            value.derived.mean_cost_per_observed_cost_leaf,
            `${path}.derived.mean_cost_per_observed_cost_leaf`,
          );
      }
      countTextMap(value.unavailable_metrics, `${path}.unavailable_metrics`);
    } else {
      optText(value.reason, `${path}.reason`, 400);
      if (value.observed !== null || value.derived !== null || value.unavailable_metrics !== null)
        problems.push(`${path} unavailable payload fields must be null`);
    }
  };
  const telemetry = (value, path) => {
    if (!object(value, path)) return;
    if (value.schema_version === 2) {
      if (Object.hasOwn(value, 'status')) telemetryV2StoredSnapshot(value, path);
      else telemetryV2(value, path);
    } else telemetryV1(value, path);
  };

  if (!object(ledger, '$')) return problems;
  fields(ledger, '$', {
    version: (value, path) => (value !== 1 ? problems.push(`${path} must be 1`) : undefined),
    run_id: (value, path) => (!LEDGER_TOKEN_RE.test(value) ? problems.push(`${path} must be a token`) : undefined),
    task_id: (value, path) => (!LEDGER_TOKEN_RE.test(value) ? problems.push(`${path} must be a token`) : undefined),
    title: (value, path) => text(value, path, 1, 1000),
    source_commit: (value, path) =>
      !LEDGER_GIT_HEX_RE.test(value) ? problems.push(`${path} must be 7..40 lower-case hex characters`) : undefined,
    workspace: (value, path) => text(value, path, 1, 1024),
    gate: (value, path) =>
      fields(value, path, {
        name: (entry, field) => text(entry, field, 1, 120),
        compatibility: (entry, field) => enumValue(entry, LEDGER_GATE_COMPATIBILITY, field),
        checked_at: (entry, field) => entry !== null && timestamp(entry, field),
        problems: (entry, field) => array(entry, field, 0, 100, (item, itemPath) => text(item, itemPath, 1, 1000)),
      }),
    status: (value, path) => enumValue(value, LEDGER_STATUSES, path),
    acceptance: (value, path) => {
      array(value, path, 1, 500, (item, itemPath) => text(item, itemPath, 1, 4000));
      if (Array.isArray(value) && new Set(value).size !== value.length)
        problems.push(`${path} must contain unique values`);
    },
    completed: (value, path) => array(value, path, 0, 10_000, work),
    pending: (value, path) => array(value, path, 0, 10_000, work),
    claims: (value, path) => array(value, path, 0, 10_000, work),
    verification: (value, path) =>
      array(value, path, 0, 10_000, (item, itemPath) =>
        fields(item, itemPath, {
          at: timestamp,
          // The entry shape is unchanged; only the type of the existing `run_id` is now actually checked.
          run_id: (entry, field) => runToken(entry, field),
          gate: (entry, field) => text(entry, field, 1, 120),
          command: (entry, field) => optText(entry, field, 2000),
          exit_code: (entry, field) =>
            !Number.isInteger(entry) || entry < 0 || entry > 255
              ? problems.push(`${field} must be integer 0..255`)
              : undefined,
          duration_ms: finiteNonNeg,
          mechanism: (entry, field) => enumValue(entry, ['evaluator'], field),
          steps: (entry, field) => array(entry, field, 0, 1000, step),
        }),
      ),
    failures: (value, path) =>
      array(value, path, 0, 10_000, (item, itemPath) =>
        fields(item, itemPath, {
          at: timestamp,
          category: (entry, field) => enumValue(entry, TAXONOMY_IDS, field),
          source: (entry, field) => enumValue(entry, LEDGER_FAILURE_SOURCES, field),
          note: (entry, field) => optText(entry, field, 400),
        }),
      ),
    invalid_transitions: (value, path) =>
      array(value, path, 0, 10_000, (item, itemPath) =>
        fields(item, itemPath, {
          at: timestamp,
          attempted_status: (entry, field) => text(entry, field, 1, 64),
          reason: (entry, field) => text(entry, field, 1, 400),
        }),
      ),
    created_at: timestamp,
    updated_at: timestamp,
  });
  if (Object.hasOwn(ledger, 'arm')) optText(ledger.arm, '$.arm', 200);
  if (Object.hasOwn(ledger, 'transitions'))
    array(ledger.transitions, '$.transitions', 0, 10_000, (item, path) =>
      fields(item, path, {
        at: timestamp,
        from: (entry, field) => enumValue(entry, LEDGER_STATUSES, field),
        to: (entry, field) => enumValue(entry, LEDGER_STATUSES, field),
        source: (entry, field) => enumValue(entry, ['evaluator', 'agent'], field),
        cause: (entry, field) => enumValue(entry, ['harness evaluate', 'harness ledger set'], field),
        run_id: (entry, field) =>
          entry !== null && !LEDGER_TOKEN_RE.test(entry)
            ? problems.push(`${field} must be null or a token`)
            : undefined,
        reason: (entry, field) => optText(entry, field, 400),
      }),
    );
  if (Object.hasOwn(ledger, 'resolved_pending'))
    array(ledger.resolved_pending, '$.resolved_pending', 0, 10_000, (item, path) =>
      fields(item, path, {
        at: timestamp,
        text: (entry, field) => text(entry, field, 1, 4000),
        source: (entry, field) => text(entry, field, 1, 64),
        resolved_by: (entry, field) => LEDGER_TOKEN_RE.test(entry) || problems.push(`${field} must be a token`),
        resolved_at: timestamp,
      }),
    );
  if (Object.hasOwn(ledger, 'acceptance_verdict'))
    enumValue(ledger.acceptance_verdict, ['pass', 'fail', 'unresolved', 'unknown'], '$.acceptance_verdict');
  if (Object.hasOwn(ledger, 'acceptance_mechanism'))
    enumValue(ledger.acceptance_mechanism, ['mechanical', 'human', 'none', 'unknown'], '$.acceptance_mechanism');
  if (Object.hasOwn(ledger, 'acceptance_coverage')) unit(ledger.acceptance_coverage, '$.acceptance_coverage');
  if (Object.hasOwn(ledger, 'acceptance_checks')) acceptanceChecks(ledger.acceptance_checks, '$.acceptance_checks');
  if (Object.hasOwn(ledger, 'acceptance_record'))
    ledger.acceptance_record === null ? undefined : humanAcceptance(ledger.acceptance_record, '$.acceptance_record');
  if (Object.hasOwn(ledger, 'acceptance_record_classification'))
    enumValue(
      ledger.acceptance_record_classification,
      ['attributed', 'operator_trust', 'not_applicable'],
      '$.acceptance_record_classification',
    );
  if (Object.hasOwn(ledger, 'verifier')) verifier(ledger.verifier, '$.verifier');
  if (Object.hasOwn(ledger, 'blockers')) array(ledger.blockers, '$.blockers', 0, 10_000, blocker);
  if (Object.hasOwn(ledger, 'integrity_clearances'))
    array(ledger.integrity_clearances, '$.integrity_clearances', 0, 10_000, (item, path) =>
      fields(item, path, {
        at: timestamp,
        run_id: (entry, field) => LEDGER_TOKEN_RE.test(entry) || problems.push(`${field} must be a token`),
        cleared_by: (entry, field) => enumValue(entry, ['computed', 'declared'], field),
        basis: (entry, field) => optText(entry, field, 400),
        clears_kind: (entry, field) => enumValue(entry, ['artifact_integrity_changed'], field),
      }),
    );
  if (Object.hasOwn(ledger, 'telemetry')) telemetry(ledger.telemetry, '$.telemetry');
  // Commit-bound evaluation records. Additive and OPTIONAL: a ledger written before this phase has no `evaluations` key
  // and reads as "not recorded" — the same discipline as `verifier` / `blockers`. Bounded like every sibling array.
  if (Object.hasOwn(ledger, 'evaluations'))
    array(ledger.evaluations, '$.evaluations', 0, EVALUATIONS_MAX_ENTRIES, evaluationEntry);
  // Environment provenance records. Additive and OPTIONAL, exactly like `evaluations`: a ledger written before this
  // phase has no `environments` key and reads as "not recorded", never as an error. Bounded by count HERE and by
  // SERIALISED BYTES on the writer side, because a count alone still lets the file exceed `LEDGER_MAX_BYTES` — and a
  // ledger over the limit is `rejected` on the next read, permanently invisible to every reader.
  if (Object.hasOwn(ledger, 'environments'))
    array(ledger.environments, '$.environments', 0, ENVIRONMENTS_MAX_ENTRIES, environmentEntry);
  return problems;
}

function ledgerIdentityDiagnostics(ledger, requestedRunId, expectedTaskId = null) {
  const problems = [];
  if (ledger.run_id !== requestedRunId)
    problems.push(`embedded run_id ${JSON.stringify(ledger.run_id)} does not match ${requestedRunId}`);
  if (expectedTaskId !== null && ledger.task_id !== expectedTaskId)
    problems.push(`embedded task_id ${JSON.stringify(ledger.task_id)} does not match ${expectedTaskId}`);
  return problems;
}

function inspectLedgerFile(path, requestedRunId, expectedTaskId = null) {
  const byteLength = lstatSync(path).size;
  const parse =
    byteLength > LEDGER_MAX_BYTES
      ? { ok: false, code: 'LEDGER_TOO_LARGE', detail: `${byteLength} bytes exceeds ${LEDGER_MAX_BYTES}` }
      : parseStrictJson(readFileSync(path));
  if (!parse.ok)
    return { classification: 'rejected', code: parse.code, diagnostics: [parse.detail], ledger: null, byteLength };
  const identity = ledgerIdentityDiagnostics(parse.value, requestedRunId, expectedTaskId);
  const shape = validateOperationalLedger(parse.value);
  if (identity.length > 0)
    return {
      classification: 'forensic_only',
      code: 'LEDGER_IDENTITY_MISMATCH',
      diagnostics: [...identity, ...shape],
      ledger: parse.value,
      byteLength,
    };
  if (shape.length > 0)
    return {
      classification: 'rejected',
      code: 'LEDGER_SHAPE_INVALID',
      diagnostics: shape,
      ledger: parse.value,
      byteLength,
    };
  return { classification: 'operational_valid', code: null, diagnostics: [], ledger: parse.value, byteLength };
}

function inspectLedgerInventory(ledgerDir = LEDGER_DIR) {
  if (!existsSync(ledgerDir)) return [];
  return readdirSync(ledgerDir)
    .filter((file) => file.endsWith('.json') && LEDGER_TOKEN_RE.test(file.slice(0, -5)))
    .sort()
    .map((file) => {
      const runId = file.slice(0, -5);
      const path = join(ledgerDir, file);
      if (!lstatSync(path).isFile())
        return {
          run_id: runId,
          filename: file,
          classification: 'rejected',
          code: 'LEDGER_NOT_REGULAR_FILE',
          diagnostics: ['not a regular file'],
          byteLength: 0,
          ledger: null,
        };
      return { run_id: runId, filename: file, ...inspectLedgerFile(path, runId) };
    });
}

function ledgerPath(runId) {
  if (!RUN_TOKEN_RE.test(runId)) {
    fail(`invalid ledger run id "${runId}" (expected 1-120 characters matching ${RUN_TOKEN_RE})`);
  }

  return resolveControlPath(LEDGER_DIR, `${runId}.json`);
}

function loadLedger(runId, expectedTaskId = null) {
  const path = ledgerPath(runId);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) fail(`LEDGER_NOT_REGULAR_FILE: ledger "${runId}" is not a regular file`);
  const inspected = inspectLedgerFile(path, runId, expectedTaskId);
  if (inspected.classification !== 'operational_valid') {
    fail(`${inspected.code}: ledger "${runId}" refused: ${inspected.diagnostics.slice(0, 5).join('; ')}`);
  }
  return inspected.ledger;
}

function listLedgers() {
  return inspectLedgerInventory()
    .filter((entry) => entry.classification === 'operational_valid')
    .map((entry) => entry.ledger);
}

function newestLedgerForTask(taskId, runId) {
  if (typeof runId === 'string') {
    const ledger = loadLedger(runId, taskId);
    if (ledger === null) fail(`no ledger for run id "${runId}"`);
    return ledger;
  }
  const candidates = inspectLedgerInventory()
    .filter((entry) => entry.classification === 'operational_valid' && entry.ledger.task_id === taskId)
    .map((entry) => entry.ledger)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.run_id.localeCompare(a.run_id));
  return candidates[0] ?? null;
}

function cmdLedgerForensic(flags) {
  if (Object.hasOwn(flags, 'task')) fail('ledger forensic does not accept --task');
  if (flags.raw === true && flags.json === true) fail('ledger forensic --raw and --json are mutually exclusive');
  const runId = flags['run-id'];
  if (typeof runId !== 'string') fail('ledger forensic requires --run-id=<id>');
  const path = ledgerPath(runId);
  if (!existsSync(path)) fail(`no ledger for run id "${runId}"`);
  if (!lstatSync(path).isFile()) fail(`LEDGER_NOT_REGULAR_FILE: ledger "${runId}" is not a regular file`);
  const size = lstatSync(path).size;
  if (size > FORENSIC_MAX_BYTES) fail('FORENSIC_INPUT_TOO_LARGE: forensic input exceeds 16777216 bytes');
  const bytes = flags.raw === true ? null : readFileSync(path);
  if (flags.raw === true) {
    const fd = openSync(path, 'r');
    try {
      const chunk = Buffer.allocUnsafe(65_536);
      let position = 0;
      while (position < size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (count === 0) fail('FORENSIC_READ_FAILED: unexpected end of file');
        process.stdout.write(chunk.subarray(0, count));
        position += count;
      }
    } finally {
      closeSync(fd);
    }
    return 0;
  }
  const parsed = parseStrictJson(bytes);
  const inspected = parsed.ok ? inspectLedgerFile(path, runId) : { code: parsed.code, diagnostics: [parsed.detail] };
  const metadata = {
    mode: 'forensic_observation',
    causal: false,
    path: relative(path),
    byte_length: size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    parse_status: parsed.ok ? 'parsed' : 'rejected',
    embedded_run_id: parsed.ok && typeof parsed.value?.run_id === 'string' ? parsed.value.run_id : null,
    filename_run_id: runId,
    identity: inspected.diagnostics.filter((entry) => entry.includes('run_id') || entry.includes('task_id')),
    diagnostics: inspected.diagnostics,
    statement: 'Historical forensic observation only. It cannot attach, mutate, classify, or select terminal state.',
  };
  if (flags.json === true) process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
  else
    process.stdout.write(
      [
        `forensic path:          ${metadata.path}`,
        `bytes:                  ${metadata.byte_length}`,
        `sha256:                 ${metadata.sha256}`,
        `parse:                  ${metadata.parse_status}`,
        `filename run id:        ${metadata.filename_run_id}`,
        `embedded run id:        ${metadata.embedded_run_id ?? '(not parseable)'}`,
        `diagnostics:            ${metadata.diagnostics.length === 0 ? 'none' : metadata.diagnostics.join('; ')}`,
        metadata.statement,
        '',
      ].join('\n'),
    );
  return 0;
}

function serializeLedger(ledger) {
  ledger.updated_at = new Date().toISOString();

  return Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
}

function initializeLedger(ledger, io = DEFAULT_FS) {
  const path = ledgerPath(ledger.run_id);
  const bytes = serializeLedger(ledger);
  let fd = null;
  let failure = null;

  try {
    fd = io.openSync(path, 'wx');
    writeAll(fd, bytes, io);
    io.fsyncSync(fd);
  } catch (error) {
    failure = stableIoError('LEDGER_INIT_FAILED', error);
  }

  if (fd !== null) {
    try {
      closeDescriptor(fd, io);
    } catch (error) {
      failure ??= stableIoError('LEDGER_INIT_CLOSE_FAILED', error);
    }
  }

  if (failure !== null) {
    throw failure;
  }

  return ledger;
}

function mutateLedger(ledger, io = DEFAULT_FS, options = {}) {
  const path = ledgerPath(ledger.run_id);
  // A1. The caller threads the digest of the bytes it actually READ. `null` means the caller asserted no base (a
  // create-shaped write), and the pre-CAS behaviour is preserved for it verbatim.
  const expectedDigest = options.expectedDigest ?? null;
  const observedDigest = ledgerBytesDigest(ledger.run_id);

  if (expectedDigest !== null && observedDigest !== expectedDigest) {
    const now = observedDigest === null ? 'absent or unreadable' : `digest ${observedDigest.slice(0, 16)}`;
    const conflict = new Error(
      `${LEDGER_WRITE_CONFLICT}: the durable ledger "${ledger.run_id}" changed underneath this process (this run read digest ${expectedDigest.slice(0, 16)}, the file on disk is now ${now}). The write was REFUSED — not merged, not overwritten. A read-modify-write on a stale base erases the other run's verification entry, transition and status, so the slower writer must never win by arriving last. The ledger_status in this run's own stream was NOT published. Re-run the evaluation against the current ledger.`,
    );

    conflict.code = LEDGER_WRITE_CONFLICT;
    // The evaluate exit protocol is unchanged: 1 is already "did not reach a terminal verified state", and a usage
    // error (2) would be a lie — nothing about the invocation was wrong.
    conflict.exitCode = 1;
    throw conflict;
  }

  const bytes = serializeLedger(ledger);
  const temp = join(dirname(path), `.${ledger.run_id}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;

  try {
    fd = io.openSync(temp, 'wx');
    writeAll(fd, bytes, io);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    io.renameSync(temp, path);
  } catch (error) {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        // The original publication error remains authoritative.
      }
    }

    try {
      io.unlinkSync(temp);
    } catch {
      // A crash can strand the temporary file; inventory ignores it.
    }

    throw stableIoError('LEDGER_MUTATION_FAILED', error);
  }

  return ledger;
}

/**
 * Append one bounded, observability-only status transition. The classifier sees the original ledger before this is
 * called, and no decision path reads this array. It is intentionally not a hash chain or an integrity mechanism.
 */
function appendLedgerTransition(ledger, { at, from, to, source, cause, runId = null, reason = null }) {
  if (from === to) {
    return;
  }

  ledger.transitions = [
    ...(ledger.transitions ?? []),
    {
      at,
      from: String(from).slice(0, 64),
      to: String(to).slice(0, 64),
      source,
      cause,
      run_id: typeof runId === 'string' ? runId.slice(0, LEDGER_TRANSITION_RUN_ID_MAX_CHARS) : null,
      reason: typeof reason === 'string' ? reason.slice(0, LEDGER_TRANSITION_REASON_MAX_CHARS) : null,
    },
  ];
}

/**
 * `verified`/`failed` may only follow mechanical verification executed by this evaluator.
 *
 * Durable-state behavior moved the decision itself into `verification-state.mjs` so the self-tests can exercise it directly; the two
 * invariants it carries (uncovered acceptance never passes; a verifier verdict is evidence, not authority) are stated
 * there, next to the code that enforces them.
 */

/** State-quality checks (Part 9): missing / contradictory / stale / unresolved pending. */
function ledgerStateQuality(ledger, workspacePath) {
  const issues = [];
  const passingVerification = (ledger.verification ?? []).filter((entry) => entry.exit_code === 0);
  // Newest appended entry: `evaluations[]` is append-only, so the last element is the most recent judged run.
  const evaluations = ledger.evaluations ?? [];
  const newestEvaluation = evaluations.length === 0 ? undefined : evaluations.at(-1);

  if (ledger.status === 'verified' && passingVerification.length === 0) {
    issues.push({ kind: 'contradictory_state', detail: 'status=verified without a passing verification entry' });
  }

  if (ledger.status === 'pending' && (ledger.completed ?? []).length > 0) {
    issues.push({ kind: 'contradictory_state', detail: 'status=pending but work is recorded as completed' });
  }

  if ((ledger.pending ?? []).length > 0 && ['verification_pending', 'verified', 'failed'].includes(ledger.status)) {
    issues.push({
      kind: 'unresolved_pending',
      detail: `${ledger.pending.length} pending item(s) at status ${ledger.status}`,
    });
  }

  if ((ledger.verification ?? []).length > 0 && (ledger.claims ?? []).length === 0) {
    issues.push({ kind: 'missing_state', detail: 'verification recorded but no agent claim' });
  }

  if ((ledger.invalid_transitions ?? []).length > 0) {
    issues.push({
      kind: 'invalid_verification_transition',
      detail: `${ledger.invalid_transitions.length} rejected transition(s)`,
    });
  }

  if (workspacePath !== undefined && existsSync(workspacePath)) {
    const head = (git(['rev-parse', 'HEAD'], workspacePath) ?? '').trim();

    const sourceCommit = typeof ledger.source_commit === 'string' ? ledger.source_commit : '';

    // Scoped (C2): this check is about a ledger that has NEVER judged anything. Its old conjunct was
    // `verification.length === 0`, which is why it could never fire again once any result existed; it now also requires
    // that no commit-bound record was written, so a ledger that HAS judged reports the judged commit instead.
    if (
      head !== '' &&
      sourceCommit !== '' &&
      head !== sourceCommit &&
      !head.startsWith(sourceCommit) &&
      (ledger.verification ?? []).length === 0 &&
      evaluations.length === 0
    ) {
      issues.push({
        kind: 'stale_state',
        detail: `workspace HEAD ${head.slice(0, 8)} differs from source_commit ${sourceCommit.slice(0, 8)} with no verification recorded`,
      });
    }
  }

  // Commit binding, record-only (C2). BOTH kinds are scoped to the newest run that actually produced an
  // `evaluations[]` entry, identified by its `run_id`. A run that appended none — `--no-gate`, gate-incompatible, or
  // unledgered — triggers NEITHER kind, so a legal non-evidence run can never manufacture state. Neither kind is an
  // enum, neither is read by a decision path, and neither can change a status or an exit code.
  if (newestEvaluation !== undefined) {
    const judged = newestEvaluation.judged_commit_pre ?? newestEvaluation.judged_commit_post ?? null;
    const declared =
      typeof newestEvaluation.declared_source_commit === 'string' ? newestEvaluation.declared_source_commit : null;

    if (judged === null) {
      issues.push({
        kind: 'result_unbound',
        detail: `the newest evaluation (run ${newestEvaluation.run_id}) recorded no observed judged commit: its result is not bound to a commit`,
      });
    } else if (declared !== null && !judged.startsWith(declared)) {
      issues.push({
        kind: 'declared_not_judged',
        detail: `the newest evaluation (run ${newestEvaluation.run_id}) judged ${judged.slice(0, 8)} while its own contract declared source_commit ${declared.slice(0, 8)}`,
      });
    }

    // P5 — the two arrays are appended by the SAME run under the SAME conditional, so their judged commits must agree.
    // A cross-wired pair (`evaluations[0].judged_commit_pre = B` beside `environments[0].judged_commit = A`, both in
    // vocabulary) previously rendered as two unflagged, differently-labelled OBSERVED facts side by side, which is
    // precisely the shape a reader cannot check. This is defence in depth: it catches a BUGGY WRITER as readily as a
    // tamper, and it authenticates nothing — forging both arrays consistently remains the declared same-principal
    // limitation. A commit that MOVED during the run is not a cross-wiring: the environment names the post sample,
    // which is one of the two the evaluation observed.
    const observedSet = new Set(
      [newestEvaluation.judged_commit_pre, newestEvaluation.judged_commit_post].filter(
        (value) => typeof value === 'string',
      ),
    );
    const environments = Array.isArray(ledger.environments) ? ledger.environments : [];
    const paired = environments.filter((entry) => entry?.run_id === newestEvaluation.run_id);

    if (environments.length > 0 && paired.length === 0) {
      issues.push({
        kind: 'environment_run_unbound',
        detail: `the ledger records ${environments.length} environment record(s) but none for run ${newestEvaluation.run_id}, the run the newest evaluation names`,
      });
    }

    for (const entry of paired) {
      const environmentCommit = typeof entry.judged_commit === 'string' ? entry.judged_commit : null;

      if (environmentCommit !== null && observedSet.size > 0 && !observedSet.has(environmentCommit)) {
        issues.push({
          kind: 'evaluation_environment_commit_mismatch',
          detail: `run ${newestEvaluation.run_id} is recorded as judging ${[...observedSet].map((value) => value.slice(0, 8)).join('/')} by evaluations[] and ${environmentCommit.slice(0, 8)} by environments[] — the same run cannot have judged two different commits`,
        });
      }
    }
  }

  return issues;
}

/**
 * The commit a result is actually ABOUT, for DISPLAY only: the commit OBSERVED in the workspace by the newest
 * `evaluations[]` entry, shown together with what that same entry declared. `ledger.source_commit` is a frozen
 * DECLARATION taken at `ledger init` — a diff base, not a statement about what was executed — so a surface that
 * prints only that value lets a result produced at commit B be read as a result for commit A. This function
 * decides nothing: no status, exit code, enum, schema shape or classifier input depends on it, and a declared
 * mismatch is NOT blocking. It returns `null` when nothing has been judged, so no surface can quietly fall back
 * to presenting the declaration as the result's commit.
 */
function judgedCommitDisplay(ledger) {
  const evaluations = Array.isArray(ledger?.evaluations) ? ledger.evaluations : [];
  const newest = evaluations.length === 0 ? undefined : evaluations.at(-1);

  if (newest === undefined) {
    return null;
  }

  const pre = typeof newest.judged_commit_pre === 'string' ? newest.judged_commit_pre : null;
  const post = typeof newest.judged_commit_post === 'string' ? newest.judged_commit_post : null;

  return {
    run_id: typeof newest.run_id === 'string' ? newest.run_id : null,
    at: typeof newest.at === 'string' ? newest.at : null,
    // The observation this result is about. `pre` is the pre-gate sample; `post` is a second sample, not a
    // correction, so a null `pre` still reports the commit the same run observed afterwards.
    observed_commit: pre ?? post,
    observed_commit_pre: pre,
    observed_commit_post: post,
    scope: typeof newest.judged_commit_scope === 'string' ? newest.judged_commit_scope : null,
    cwd: typeof newest.judged_cwd === 'string' ? newest.judged_cwd : null,
    declared_source_commit: typeof newest.declared_source_commit === 'string' ? newest.declared_source_commit : null,
  };
}

function cmdLedger(args) {
  // The subcommand IS the first non-`--` token, so it is removed BY POSITION before the flag boundary sees the rest.
  // Removing by value would be wrong: `ledger show --task=show` would lose the flag too.
  const subIndex = args.findIndex((arg) => !arg.startsWith('--'));
  const sub = subIndex === -1 ? 'show' : args[subIndex];
  const rest = args.filter((_, index) => index !== subIndex);
  const flags = parseFlags(rest, { command: 'ledger', subcommand: sub });

  if (sub === 'forensic') return cmdLedgerForensic(flags);

  const taskId = flags.task;
  if (typeof taskId !== 'string') fail('ledger requires --task=<id>');
  const task = findTask(taskId);

  switch (sub) {
    case 'init':
      return cmdLedgerInit(task, flags);
    case 'set':
      return cmdLedgerSet(task, flags);
    case 'show':
      return cmdLedgerShow(task, flags);
    default:
      fail(`unknown ledger subcommand "${sub}" (init | set | show | forensic)`);
      return 2;
  }
}

function cmdLedgerInit(task, flags) {
  const runId = typeof flags['run-id'] === 'string' ? flags['run-id'] : generatedRunId(`ledger-${task.id}`);

  if (!RUN_TOKEN_RE.test(runId)) {
    fail(`invalid ledger run id "${runId}" (expected 1-120 characters matching ${RUN_TOKEN_RE})`);
  }

  const gate = task.verification?.gate ?? DEFAULT_GATE;
  const ledger = initializeLedger({
    version: LEDGER_VERSION,
    run_id: runId,
    task_id: task.id,
    arm: typeof flags.arm === 'string' ? flags.arm : null,
    title: task.title,
    source_commit: task.source_commit,
    workspace: typeof flags.workspace === 'string' ? flags.workspace : '.',
    gate: { name: gate, compatibility: null, checked_at: null, problems: [] },
    status: 'pending',
    // STATE-MODEL: additive observability. Historical ledgers omit this field and are displayed as "not recorded".
    transitions: [],
    // Commit-bound evaluation records: additive, optional, non-causal. Historical ledgers omit this field and are
    // displayed as "not recorded"; nothing is inferred from it.
    evaluations: [],
    acceptance: task.acceptance,
    completed: [],
    pending: [],
    claims: [],
    verification: [],
    failures: [],
    invalid_transitions: [],
    // Durable-state behavior — additive: a verifier record slot and the evaluator's blockers. Historical ledgers lack both and are
    // read through `?? null` / `?? []`, so nothing needs migrating.
    verifier: null,
    blockers: [],
    created_at: new Date().toISOString(),
  });

  process.stdout.write(
    `ledger ${ledger.run_id}\n  task:      ${task.id} (${task.title})\n  arm:       ${ledger.arm ?? 'unlabelled'}\n  source:    ${task.source_commit}\n  gate:      ${gate}\n  status:    ${ledger.status}\n  acceptance criteria: ${task.acceptance.length}\n`,
  );

  return 0;
}

function cmdLedgerSet(task, flags) {
  const ledger = newestLedgerForTask(task.id, typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined);
  // A1: the same compare-and-swap base as `evaluate`. A `ledger set` racing an `evaluate` must lose the same way.
  const ledgerBaseDigest = ledgerBytesDigest(ledger.run_id);

  if (ledger === null) {
    fail(`no ledger for task ${task.id} — run: node .harness/runtime/harness.mjs ledger init --task=${task.id}`);
  }

  const at = new Date().toISOString();
  const previousStatus = ledger.status;
  const status = typeof flags.status === 'string' ? flags.status : null;

  if (status !== null && !LEDGER_STATUSES.includes(status)) {
    fail(`unknown status "${status}" (${LEDGER_STATUSES.join(' | ')})`);
  }

  if (status !== null && EVALUATOR_ONLY_STATUSES.includes(status)) {
    ledger.invalid_transitions = [
      ...(ledger.invalid_transitions ?? []),
      { at, attempted_status: status, reason: 'evaluator-only status: requires mechanical verification evidence' },
    ];
    mutateLedger(ledger, DEFAULT_FS, { expectedDigest: ledgerBaseDigest });
    fail(
      `status "${status}" is evaluator-only — it is set by \`harness evaluate\` after the gate actually runs (recorded as an invalid transition)`,
    );
  }

  if (status !== null) {
    ledger.status = status;
  }

  if (typeof flags.completed === 'string') {
    ledger.completed = [...(ledger.completed ?? []), { at, text: flags.completed, source: 'agent' }];
  }

  if (typeof flags.pending === 'string') {
    ledger.pending = [...(ledger.pending ?? []), { at, text: flags.pending, source: 'agent' }];
  }

  if (flags['clear-pending'] === true) {
    ledger.pending = [];
  }

  if (typeof flags.claim === 'string') {
    ledger.claims = [...(ledger.claims ?? []), { at, text: flags.claim, source: 'agent' }];
  }

  if (typeof flags.failure === 'string') {
    const separator = flags.failure.indexOf(':');
    const category = separator === -1 ? flags.failure : flags.failure.slice(0, separator);
    const note = separator === -1 ? null : flags.failure.slice(separator + 1);

    if (!TAXONOMY_IDS.includes(category)) {
      fail(`unknown failure category "${category}" (see: harness taxonomy)`);
    }

    ledger.failures = [...(ledger.failures ?? []), { at, category, note, source: 'agent' }];
  }

  // Structural behavior: unfinishable work must have an honest exit. A blocker is a recorded reason, not a verdict, and
  // it moves the task to `blocked` unless a status was given explicitly.
  if (typeof flags.blocker === 'string') {
    ledger.blockers = [...(ledger.blockers ?? []), { at, text: flags.blocker, source: 'agent' }];

    if (status === null) {
      ledger.status = 'blocked';
    }
  }

  appendLedgerTransition(ledger, {
    at,
    from: previousStatus,
    to: ledger.status,
    source: 'agent',
    cause: 'harness ledger set',
    reason: status === null && typeof flags.blocker === 'string' ? flags.blocker : null,
  });

  mutateLedger(ledger, DEFAULT_FS, { expectedDigest: ledgerBaseDigest });
  process.stdout.write(
    `ledger ${ledger.run_id}: status=${ledger.status}, completed=${ledger.completed.length}, pending=${ledger.pending.length}\n`,
  );

  return 0;
}

/**
 * P2 — the environment record a ledger's newest judged run left behind, joined the way the writer wrote it.
 *
 * `environments[].run_id` is the EVALUATION run id; `ledger.run_id` is the LEDGER id. They are different namespaces
 * and never equal (`ledA` vs `runA`), so joining them made every ledger report `environment: null` and printed
 * `environments: 0/7` on a corpus where 6 of 7 valid ledgers carry one — an under-count whose printed claim ("read
 * from the durable environments[] record") was false. `ledger show` already used the newest entry and was right, so
 * the two surfaces disagreed about the same bytes.
 *
 * The join now names the newest `evaluations[]` run id — the one record both arrays are written under, under the same
 * conditional — and falls back to the newest entry, which is the same record whenever the join is available. One
 * function, used by `ledger show`, `report` and the state-quality cross-check, so the surfaces cannot drift again.
 */
function newestEnvironmentRecord(ledger) {
  const environments = Array.isArray(ledger?.environments) ? ledger.environments : [];

  if (environments.length === 0) {
    return null;
  }

  const evaluationRunIds = new Set(
    (Array.isArray(ledger?.evaluations) ? ledger.evaluations : [])
      .map((entry) => entry?.run_id)
      .filter((value) => typeof value === 'string'),
  );

  return environments.find((entry) => evaluationRunIds.has(entry?.run_id)) ?? environments.at(-1);
}

/**
 * P3 — the commit-blind selection disclosure, as ONE value both display paths render.
 *
 * The human output has always said `selection: newest updated_at, then newest run_id — NOT commit-aware`; the JSON
 * carried `{ledger, judged_commit, state_quality}` and no equivalent, so a JSON consumer could not tell that the
 * object it holds is one of N candidates picked by RECENCY. A disclosure that exists on one surface and not another
 * is not a disclosure. `commit_aware: false` and `candidates` are deliberately machine-readable, and
 * `candidates` is computed from the same inventory `newestLedgerForTask` selects from, so the number cannot be a
 * flattering constant.
 */
const LEDGER_SELECTION_DISCLOSURE = {
  selection: 'newest updated_at, then newest run_id',
  commit_aware: false,
  rule: 'newest updated_at, then newest run_id — NOT commit-aware; read judged_commit, not source_commit',
  limit:
    'default ledger selection picks one of several commit-blind candidates by RECENCY alone; it is not evidence that the chosen ledger judged the commit you care about. Read judged_commit, and pass --run-id to name a ledger yourself.',
};

/** The environment summary as display lines, with its basis and the standing limitation, in the same shape. */
function environmentDisplayLines(ledger) {
  const entry = newestEnvironmentRecord(ledger);

  if (entry === null) {
    return [
      'environment:         (not recorded — this ledger predates environment provenance, or no gate-bearing run has been appended)',
    ];
  }

  return [
    `environment:         ${entry.dependency_provisioning} (${entry.dependency_provisioning_basis}; ${entry.node_modules_topology}, ${entry.node_modules_scope}) — run ${entry.run_id}`,
    `environment commit:  ${entry.judged_commit ?? '(not recorded)'} — OBSERVED in the workspace the gate ran in; the declared source_commit above is a separate fact`,
    `dependency state:    ${entry.installed_package_count ?? 'n/a'} installed entries, installed_state_digest ${entry.installed_state_digest ?? '(none)'} (${entry.installed_state_digest_source ?? 'no record'}; declared by npm, not an independent observation of the bytes)`,
    `installed tree:      installed_tree_fingerprint ${entry.installed_tree_fingerprint ?? 'not computed'} (${entry.installed_tree_fingerprint_tier ?? 'no tier'} tier; ${entry.installed_tree_fingerprint_limitation ?? 'this run computed no tree walk — the workspace attestation records one'})`,
    `gate environment:    ${entry.gate_env_policy ?? 'not recorded'}`,
    `install scripts:     executed=${String(entry.historical_install_executed_arbitrary_scripts)} (${entry.historical_install_scripts_policy ?? 'no install performed by this command'}) — npm does not report whether a lifecycle script ran`,
    `resolver probe:      ${entry.resolver_probe === null ? '(not run — this invocation ran no gate)' : `${entry.resolver_probe.length} probed, ${entry.resolver_probe.filter((probe) => probe.resolved !== null).length} resolved`}`,
    `toolchain:           ${entry.package_manager?.name ?? '?'} ${entry.package_manager?.version ?? '?'} (${entry.package_manager?.resolved_from ?? 'unresolved'}; declared packageManager field: ${entry.package_manager?.declared_field ?? 'absent'}) · node ${entry.node?.version ?? '?'} · ${entry.platform?.os ?? '?'}/${entry.platform?.arch ?? '?'}`,
    `environment basis:   env digest ${entry.env?.vars_digest ?? '(none)'} over ${entry.env?.count ?? 0} constructed variable(s) — values are never recorded`,
    ...(entry.npm_config_files === undefined || entry.npm_config_files === null
      ? []
      : [
          `npm config files:  user ${entry.npm_config_files.user_config_path} (${entry.npm_config_files.user_config_source}; digest ${entry.npm_config_files.user_config_digest ?? 'absent'}) · global ${entry.npm_config_files.global_config_path ?? '(none found)'} (digest ${entry.npm_config_files.global_config_digest ?? 'absent'})`,
          `npm registry:      ${entry.npm_config_files.registry ?? '(not queried — no npm config file was present)'} — ${entry.npm_config_files.registry_basis ?? 'basis not recorded'}`,
          'npm config limit:  a config FILE is a channel the environment sanitisation does NOT close: this is a RECORDED LIMIT, not a solved problem',
        ]),
    ...(entry.bounded_reason === null ? [] : [`environment bound:   ${entry.bounded_reason}`]),
    'environment limits:  a worktree is not a security boundary, and historical reproducibility is not result authenticity',
  ];
}

function cmdLedgerShow(task, flags) {
  const ledger = newestLedgerForTask(task.id, typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined);

  if (ledger === null) {
    process.stdout.write(`no ledger for task ${task.id}\n`);

    return 0;
  }

  const workspacePath = resolve(REPO_ROOT, ledger.workspace ?? '.');
  const issues = ledgerStateQuality(ledger, workspacePath);

  const judged = judgedCommitDisplay(ledger);

  // P3: the selection is commit-BLIND, and the number of candidates is read from the same inventory the selection is
  // made from — never asserted — so a reader of either surface is told the same, true thing. `listLedgers()` returns the
  // LEDGER objects, not inventory entries, so the task filter reads `task_id` off the ledger itself.
  const selection = {
    ...LEDGER_SELECTION_DISCLOSURE,
    candidates: listLedgers().filter((ledgerEntry) => ledgerEntry?.task_id === task.id).length,
    candidates_are_commit_blind: true,
  };

  if (flags.json === true) {
    const displayedLedger = ledger.transitions === undefined ? { ...ledger, transitions: null } : ledger;

    // `ledger.source_commit` is the declaration frozen at init; `judged_commit` is the observed record. They are
    // separate top-level keys so a JSON consumer cannot confuse the two. `selection` is the SAME value the human
    // surface renders: a disclosure present on one surface and absent from the other is not a disclosure.
    process.stdout.write(
      `${JSON.stringify({ ledger: displayedLedger, judged_commit: judged, state_quality: issues, selection }, null, 2)}\n`,
    );

    return 0;
  }

  const lastVerification = (ledger.verification ?? []).at(-1);

  process.stdout.write(
    [
      '',
      `ledger:        ${ledger.run_id} (v${ledger.version})`,
      `task:          ${ledger.task_id} — ${ledger.title}`,
      `arm:           ${ledger.arm ?? 'unlabelled'}`,
      // Declaration and observation are BOTH printed and LABELLED, because they can differ: the declaration is
      // frozen at `ledger init`, the observation is what the newest judged run actually saw. Printing the frozen
      // `source_commit` next to `status: verified` with no observation is what made a commit-B result readable as
      // a result for commit A.
      `source_commit: ${ledger.source_commit} — DECLARED at ledger init (a diff base, not what was judged)`,
      `judged_commit: ${
        judged === null || judged.observed_commit === null
          ? '(none recorded — this ledger has judged no commit; the declaration above is not a result)'
          : `${judged.observed_commit} — OBSERVED, run ${judged.run_id ?? '(unknown run)'}`
      }`,
      ...(judged === null || judged.observed_commit === null
        ? []
        : [
            `judged_post:    ${judged.observed_commit_post ?? '(not recorded)'} — the same observation after the gate`,
            `judged_scope:   ${judged.scope ?? '(unresolved)'}   judged_cwd: ${judged.cwd ?? '(unresolved)'}`,
            `declared_then:  ${
              judged.declared_source_commit === null
                ? 'the judged run recorded no declared commit'
                : judged.observed_commit.startsWith(judged.declared_source_commit)
                  ? 'the judged run declared the commit it observed'
                  : `DIFFERENT from the commit that run declared (${judged.declared_source_commit}) — recorded, not blocking`
            }`,
          ]),
      // The environment summary is shown NEXT TO the two commits and never merged with them: the DECLARED
      // `source_commit` and the OBSERVED `judged_commit` keep their own labelled lines, and the environment is a third,
      // separate observation. A historical ledger with no `environments` key reads as "not recorded", which is a
      // normal state and not an error.
      ...environmentDisplayLines(ledger),
      `selection:      ${selection.rule} (${selection.candidates} commit-blind candidate ledger(s) for this task)`,
      `workspace:     ${ledger.workspace}`,
      `gate:          ${ledger.gate?.name ?? '-'} (${ledger.gate?.compatibility ?? 'not checked'})`,
      `status:        ${ledger.status}`,
      `acceptance:    ${ledger.acceptance_verdict ?? 'not judged'} (${ledger.acceptance.length} criteria)`,
      `coverage:      ${
        ledger.acceptance_checks === undefined || ledger.acceptance_checks === null
          ? 'not mechanically evaluated'
          : `${ledger.acceptance_checks.coverage_state ?? 'unknown'} — ${ledger.acceptance_checks.criteria_covered}/${ledger.acceptance_checks.criteria_total} criteria covered`
      }`,
      '',
      'acceptance criteria (state from the newest mechanical evaluation, where one exists):',
      ...ledger.acceptance.map((criterion, index) => {
        const detail = (ledger.acceptance_checks?.criteria ?? []).find((entry) => entry.criterion === index + 1);

        return `  - [${detail?.state ?? 'not evaluated'}] ${criterion}`;
      }),
      '',
      `completed (${ledger.completed.length}):`,
      ...(ledger.completed.length === 0 ? ['  (none)'] : ledger.completed.map((item) => `  - ${item.text}`)),
      '',
      `pending (${ledger.pending.length}):`,
      ...(ledger.pending.length === 0 ? ['  (none)'] : ledger.pending.map((item) => `  - ${item.text}`)),
      '',
      `claims (${ledger.claims.length}) — NOT evidence:`,
      ...(ledger.claims.length === 0 ? ['  (none)'] : ledger.claims.map((claim) => `  - ${claim.text}`)),
      '',
      `verification evidence (${ledger.verification.length}) — written by the evaluator only:`,
      ...(ledger.verification.length === 0
        ? ['  (none)']
        : ledger.verification.map(
            (entry) => `  - ${entry.at} ${entry.gate} exit=${entry.exit_code} (${entry.duration_ms} ms)`,
          )),
      lastVerification === undefined ? '' : `  last: ${JSON.stringify(lastVerification.command)}`,
      '',
      `failures (${ledger.failures.length}):`,
      ...(ledger.failures.length === 0
        ? ['  (none)']
        : ledger.failures.map((failure) => `  - ${failure.category} (${failure.source}) ${failure.note ?? ''}`)),
      '',
      `status transitions (${
        ledger.transitions === undefined ? 'not recorded' : ledger.transitions.length
      }) — observability only, not authority:`,
      ...(ledger.transitions === undefined
        ? ['  (not recorded; ledger predates STATE-MODEL)']
        : ledger.transitions.length === 0
          ? ['  (none)']
          : ledger.transitions.map(
              (transition) =>
                `  - ${transition.at} ${transition.from} → ${transition.to} (${transition.source}: ${transition.cause}${transition.run_id ? `, run=${transition.run_id}` : ''})${transition.reason ? ` — ${transition.reason}` : ''}`,
            )),
      '',
      `blockers (${(ledger.blockers ?? []).length}) — why a non-success status was reached:`,
      ...((ledger.blockers ?? []).length === 0
        ? ['  (none)']
        : (ledger.blockers ?? []).map((blocker) => `  - ${blocker.kind ?? 'blocker'}: ${blocker.text ?? ''}`)),
      '',
      `verifier evidence: ${
        ledger.verifier === undefined || ledger.verifier === null
          ? 'none recorded (no verifier ran, or the ledger predates Durable-state behavior)'
          : `${ledger.verifier.verdict} (artifact_integrity=${ledger.verifier.artifact_integrity}, source=${ledger.verifier.source}, ${ledger.verifier.criteria_checked.length} criteria checked, ${ledger.verifier.findings.length} findings)`
      }`,
      ...(ledger.verifier === undefined || ledger.verifier === null
        ? []
        : [
            ...ledger.verifier.findings.map((finding) => `  - ${finding.mechanism ?? finding.text ?? ''}`),
            `  authority: ${ledger.verifier.authority}`,
          ]),
      '',
      `invalid transitions rejected (${(ledger.invalid_transitions ?? []).length}):`,
      ...((ledger.invalid_transitions ?? []).length === 0
        ? ['  (none)']
        : ledger.invalid_transitions.map(
            (transition) => `  - ${transition.attempted_status} at ${transition.at}: ${transition.reason}`,
          )),
      '',
      `state quality: ${issues.length === 0 ? 'ok' : issues.map((issue) => issue.kind).join(', ')}`,
      ...issues.map((issue) => `  - ${issue.kind}: ${issue.detail}`),
      '',
      `updated_at:    ${ledger.updated_at}`,
      '',
    ].join('\n'),
  );

  return 0;
}

// ---------------------------------------------------------------- Structural behavior — telemetry snapshot

/**
 * Snapshot the runtime's telemetry for one run.
 * Returns an explicit `unavailable` state with a reason instead of zeros whenever the store cannot be read or
 * cannot be matched to this run — a missing measurement must never masquerade as a zero measurement.
 */
function snapshotTelemetry(storeFlag, expectedTaskId) {
  const base = {
    schema_version: 2,
    status: 'unavailable',
    reason: null,
    observed: null,
    derived: null,
    unavailable_metrics: null,
  };

  if (typeof storeFlag !== 'string' || storeFlag === '') {
    return { ...base, reason: 'no --telemetry-store supplied' };
  }

  const store = resolve(REPO_ROOT, storeFlag);

  if (!existsSync(store)) {
    return { ...base, reason: `telemetry store not found: ${storeFlag}` };
  }

  const actualTaskId = store.split('/').filter(Boolean).pop();

  if (typeof expectedTaskId === 'string' && expectedTaskId !== '' && actualTaskId !== expectedTaskId) {
    return { ...base, reason: `store directory "${actualTaskId}" does not match --store-task-id="${expectedTaskId}"` };
  }

  const summary = telemetryForTaskDir(store);

  if (summary.acquisition.status === 'unavailable') {
    return { ...base, reason: summary.acquisition.reason };
  }

  return {
    schema_version: 2,
    status: 'available',
    reason: null,
    store_task_id: summary.task_id,
    observed: summary.observed.messages,
    derived: summary.derived,
    unavailable_metrics: summary.unavailable_metrics,
  };
}

// ---------------------------------------------------------------- Structural behavior — mode validation

/**
 * Validate `.roomodes` before anything depends on it.
 *
 * Runtime telemetry measured that a schema-invalid `groups` entry invalidates the WHOLE file, silently, and that the
 * agent-visible symptom names an unrelated slug. This command makes that failure visible and refuses to claim
 * that role isolation is active when the file cannot be trusted.
 */
function cmdModes(flags) {
  const file = typeof flags.file === 'string' ? resolve(REPO_ROOT, flags.file) : join(REPO_ROOT, '.roomodes');

  if (!existsSync(file)) {
    process.stdout.write(`modes: ${relative(file)} not found\nmode_file: INVALID\n`);

    return 1;
  }

  const lines = readFileSync(file, 'utf8').split('\n');
  const errors = [];
  const warnings = [];
  const modes = [];
  const GROUP_NAMES = ['read', 'edit', 'command', 'mcp', 'modes', 'browser'];
  let current = null;
  let inGroups = false;
  // Tuple group entries ("- - read" followed by deeper-indented option lines) carry their options as a
  // sub-list; those lines must be consumed, not mistaken for group names.
  let tupleIndent = -1;

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, '');
    const where = `${relative(file)}:${index + 1}`;

    if (/^\s*-\s+slug:\s*\S+/.test(line)) {
      if (current !== null) {
        modes.push(current);
      }

      current = {
        slug: line.split(':')[1].trim(),
        groups: [],
        hasMcpAllowList: false,
        hasRoleDefinition: false,
        fileRegex: false,
      };
      inGroups = false;
      tupleIndent = -1;
      continue;
    }

    if (current === null) {
      continue;
    }

    if (/^\s*roleDefinition:/.test(line)) {
      current.hasRoleDefinition = true;
      inGroups = false;
      continue;
    }

    if (/^\s*allowedMcpServers:/.test(line)) {
      current.hasMcpAllowList = true;
      inGroups = false;
      continue;
    }

    if (/^\s*groups:\s*$/.test(line)) {
      inGroups = true;
      continue;
    }

    if (inGroups) {
      if (tupleIndent >= 0) {
        const indent = line.length - line.trimStart().length;

        if (line.trim() !== '' && indent > tupleIndent) {
          if (/^\s*-\s+fileRegex:/.test(line)) {
            current.fileRegex = true;
          }

          continue;
        }

        tupleIndent = -1;
      }

      // Rejected form (measured in Runtime telemetry): a mapping entry invalidates the entire file.
      const mapping = line.match(/^\s*-\s+([a-z]+):\s*$/);

      if (mapping !== null) {
        errors.push(
          `${where}: group entry "${mapping[1]}" uses the mapping form ("- ${mapping[1]}:" with nested keys) — this invalidates the whole file; use a plain "- ${mapping[1]}" or the tuple form`,
        );
        continue;
      }

      const tuple = line.match(/^\s*-\s+-\s+([a-z]+)\s*$/);

      if (tuple !== null) {
        current.groups.push(tuple[1]);
        tupleIndent = line.length - line.trimStart().length;
        continue;
      }

      const plain = line.match(/^\s*-\s+([a-z]+)\s*$/);

      if (plain !== null) {
        current.groups.push(plain[1]);
        continue;
      }

      if (/^\s*-\s+\S/.test(line)) {
        errors.push(`${where}: unrecognised group entry "${line.trim()}"`);
      } else if (!/^\s*$/.test(line) && !/^\s*(name|whenToUse|description|customInstructions|source):/.test(line)) {
        inGroups = false;
      }
    }
  }

  if (current !== null) {
    modes.push(current);
  }

  const slugs = new Set();

  for (const mode of modes) {
    if (slugs.has(mode.slug)) {
      errors.push(`duplicate mode slug "${mode.slug}"`);
    }

    slugs.add(mode.slug);

    if (!mode.hasRoleDefinition) {
      errors.push(`mode "${mode.slug}": missing required "roleDefinition"`);
    }

    for (const group of mode.groups) {
      if (!GROUP_NAMES.includes(group)) {
        errors.push(`mode "${mode.slug}": unknown group "${group}"`);
      }
    }

    const hasMcp = mode.groups.includes('mcp');

    if (hasMcp && !mode.hasMcpAllowList) {
      warnings.push(
        `mode "${mode.slug}": has the mcp group without an allowedMcpServers list — every connected server is exposed (Runtime telemetry measured ~51 tools with no list)`,
      );
    }

    if (!hasMcp && mode.hasMcpAllowList) {
      warnings.push(
        `mode "${mode.slug}": declares allowedMcpServers without the mcp group — the allow-list is inert (the group is the coarse gate)`,
      );
    }

    if (mode.fileRegex) {
      warnings.push(
        `mode "${mode.slug}": declares a fileRegex — it is enforced for the edit group only; on the read group it is accepted and IGNORED (Runtime telemetry probe P4)`,
      );
    }

    process.stdout.write(
      `  ${mode.slug.padEnd(22)} groups=[${mode.groups.join(',')}] mcp=${hasMcp ? (mode.hasMcpAllowList ? 'allow-list' : 'ALL') : 'none'} writes=${mode.groups.includes('edit') ? 'yes' : 'no'} fileRegex=${mode.fileRegex ? 'yes' : 'no'}\n`,
    );
  }

  for (const warning of warnings) {
    process.stdout.write(`  WARN  ${warning}\n`);
  }

  for (const error of errors) {
    process.stdout.write(`  ERROR ${error}\n`);
  }

  const validated = errors.length === 0;
  // The label names what was MEASURED: the mode file PARSED with zero errors. It is deliberately not called
  // "isolation" — a narrower tool surface is not a security boundary, and a machine-printed token is exactly where a
  // reader would infer one.
  process.stdout.write(
    `\nmodes: ${modes.length} defined, ${errors.length} error(s), ${warnings.length} warning(s)\nmode_file: ${validated ? 'VALID' : 'INVALID'}\n`,
  );

  if (!validated) {
    process.stdout.write(
      '  (an invalid .roomodes makes every custom mode unselectable; verify by LAUNCHING a mode, not by reading the file)\n',
    );
  }

  return validated ? 0 : 1;
}

// ---------------------------------------------------------------- Structural behavior — structured handoff

function cmdHandoff(flags) {
  if (flags.template === true) {
    process.stdout.write(`${JSON.stringify(handoffTemplate(), null, 2)}\n`);

    return 0;
  }

  const file = typeof flags.check === 'string' ? resolve(REPO_ROOT, flags.check) : null;

  if (file === null) {
    fail('handoff requires --template or --check=<file>');
  }

  if (!existsSync(file)) {
    fail(`handoff file not found: ${flags.check}`);
  }

  const verdict = validateHandoffText(readFileSync(file, 'utf8'));

  if (verdict.ok) {
    process.stdout.write(`handoff ${relative(file)}: OK\n`);

    return 0;
  }

  process.stdout.write(`handoff ${relative(file)}: REJECTED\n`);

  for (const problem of verdict.problems) {
    process.stdout.write(`  - ${problem}\n`);
  }

  return 1;
}

// ---------------------------------------------------------------- Threshold validation — predicate registry

/** The historical solving commit, parsed from the contract's `history.evidence` ("git show <sha> --stat"). */
function solvingCommitFor(task) {
  const evidence = task.history && typeof task.history.evidence === 'string' ? task.history.evidence : '';
  const match = evidence.match(/\b([0-9a-f]{7,40})\b/);

  return match ? match[1] : null;
}

/**
 * Predicate coverage and discrimination validation.
 *
 * `--validate` is the operation Structural behavior lacked: it re-derives, for every declared predicate, whether the
 * predicate actually discriminates the task's source commit from its historical solving commit. A predicate
 * that already passes at the source commit is REJECTED (it cannot witness the work); one that fails at both is
 * NON_DISCRIMINATING; one that fails at source and passes at the solving commit is VALIDATED.
 *
 * Structural kinds (`gate_passed`, `diff_scope`) are not text predicates: they are reported as
 * VALIDATED_STRUCTURAL and their semantics are covered by the self-tests instead.
 */
function cmdPredicates(flags) {
  // Predicate corpora are optional inputs, not part of the command. Callers may supply explicit paths.
  const inventoryCandidates = ['predicate-corpus', 'predicate-inventory']
    .map((name) => flags[name])
    .filter((value) => typeof value === 'string' && value !== '')
    .map((value) => resolve(REPO_ROOT, value));
  const inventoryPath = inventoryCandidates.find((candidate) => existsSync(candidate)) ?? null;
  const tasks = loadTasks()
    .filter((entry) => entry.task !== null)
    .map((entry) => entry.task);
  const declared = [];

  for (const task of tasks) {
    for (const check of task.acceptance_checks ?? []) {
      declared.push({ task, check });
    }
  }

  const rows = [];

  for (const { task, check } of declared) {
    const base = { task: task.id, check: check.id, kind: check.kind, criterion: check.criterion };

    if (flags.validate !== true) {
      rows.push(base);
      continue;
    }

    if (check.kind === 'gate_passed' || check.kind === 'diff_scope') {
      rows.push({
        ...base,
        status: 'VALIDATED_STRUCTURAL',
        detail: `${check.kind} is decided by execution state (the gate result / the commit diff), not by workspace text`,
      });
      continue;
    }

    if (check.kind === 'file_exists' || check.kind === 'keyset_equal') {
      // These evaluate the working tree only, so they cannot be shown to discriminate a past revision.
      rows.push({
        ...base,
        status: 'UNVALIDATED',
        detail: `${check.kind} is not evaluable at a revision — discrimination cannot be demonstrated for it`,
      });
      continue;
    }

    const solving = solvingCommitFor(task);

    if (solving === null || !commitExists(solving)) {
      rows.push({ ...base, status: 'NO_REFERENCE', detail: 'no reachable solving commit to compare against' });
      continue;
    }

    if (check.rev !== undefined && check.rev !== task.source_commit) {
      // A predicate that pins its own revision cannot be validated against the task's states, and silently
      // re-pointing it would hide that. Report it instead (found by the Threshold validation adversarial self-tests).
      rows.push({
        ...base,
        status: 'UNVALIDATED',
        detail: `pins rev=${check.rev}, which is not the task's source commit (${task.source_commit})`,
      });
      continue;
    }

    const context = {
      workspace: REPO_ROOT,
      sourceCommit: task.source_commit,
      gate: { ran: false, exitCode: null, name: null },
    };
    const atSource = evaluateCheck({ ...check, rev: task.source_commit }, context);
    const atSolving = evaluateCheck({ ...check, rev: solving }, context);

    if (atSource.status === 'error' || atSolving.status === 'error') {
      rows.push({
        ...base,
        status: 'UNRESOLVED',
        detail: `source=${atSource.status} (${atSource.detail}) | solving=${atSolving.status} (${atSolving.detail})`,
      });
      continue;
    }

    if (atSource.status === 'pass') {
      rows.push({
        ...base,
        status: 'REJECTED',
        detail: `already passes at the SOURCE commit (${atSource.detail}) — it cannot witness the work`,
      });
      continue;
    }

    if (atSolving.status === 'fail') {
      rows.push({
        ...base,
        status: 'NON_DISCRIMINATING',
        detail: `fails at both commits (solving: ${atSolving.detail}) — criterion or predicate is mis-specified`,
      });
      continue;
    }

    rows.push({ ...base, status: 'VALIDATED', detail: `source: ${atSource.detail} | solving: ${atSolving.detail}` });
  }

  const warnings = declared.flatMap(({ task, check }) =>
    predicateWarnings(check).map((warning) => `${task.id} ${warning}`),
  );
  const counts = {};

  for (const row of rows) {
    const key = row.status ?? 'DECLARED';
    counts[key] = (counts[key] ?? 0) + 1;
  }

  let inventory = null;

  if (inventoryPath !== null && existsSync(inventoryPath)) {
    try {
      inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    } catch {
      inventory = null;
    }
  }

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ rows, warnings, counts, inventory_present: inventory !== null }, null, 2)}\n`,
    );

    return rows.some((row) => ['REJECTED', 'NON_DISCRIMINATING', 'UNRESOLVED'].includes(row.status)) ? 1 : 0;
  }

  process.stdout.write('\nacceptance predicates\n\n');

  for (const row of rows) {
    process.stdout.write(
      `  ${row.task.padEnd(5)} #${String(row.criterion).padEnd(2)} ${String(row.check).padEnd(26)} ${String(row.kind).padEnd(16)} ${row.status ?? ''}${row.detail ? ` — ${row.detail}` : ''}\n`,
    );
  }

  process.stdout.write(`\n  declared predicates: ${rows.length}\n`);

  for (const [status, count] of Object.entries(counts).sort()) {
    process.stdout.write(`  ${status.padEnd(22)} ${count}\n`);
  }

  if (inventory !== null) {
    const criteria = inventory.criteria ?? [];
    const byClass = criteria.reduce((acc, entry) => ({ ...acc, [entry.class]: (acc[entry.class] ?? 0) + 1 }), {});
    const byStatus = criteria.reduce((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {});

    process.stdout.write(
      `\n  criterion inventory: ${criteria.length} criteria across ${new Set(criteria.map((entry) => entry.task)).size} contracts\n` +
        `    classification:  ${Object.entries(byClass)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}\n` +
        `    predicate status: ${Object.entries(byStatus)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}\n`,
    );
  } else {
    process.stdout.write(
      '\n  criterion inventory: NOT FOUND (optional corpus not supplied; use --predicate-inventory=<path>)\n',
    );
  }

  for (const warning of warnings) {
    process.stdout.write(`  WARN  ${warning}\n`);
  }

  process.stdout.write(
    '\n  reminder: mechanically_checkable != validated predicate. VALIDATED requires positive discrimination\n' +
      '  (fails at source, passes at solving); REJECTED means it already passes at the source commit.\n',
  );

  return rows.some((row) => ['REJECTED', 'NON_DISCRIMINATING', 'UNRESOLVED'].includes(row.status)) ? 1 : 0;
}

// ---------------------------------------------------------------- report

// ---------------------------------------------------------------- Runtime telemetry telemetry

/** Optional run attribution. When no flag is supplied, every field is null. */
function collectExperimentContext(flags) {
  const pick = (name) => (typeof flags[name] === 'string' && flags[name] !== '' ? flags[name] : null);
  const context = {
    experiment: pick('experiment'),
    arm: pick('arm'),
    role: pick('role'),
    tool_profile: pick('tool-profile'),
    mcp_profile: pick('mcp-profile'),
  };

  return Object.values(context).every((value) => value === null) ? null : context;
}

/**
 * Resolve the runtime's task-store directory. Deliberately NOT hardcoded: the store lives outside the
 * repository and its location is host-specific, so the path must be supplied explicitly.
 */
function resolveTaskStore(flags) {
  const fromFlag = typeof flags.store === 'string' ? flags.store : null;
  const fromEnv =
    typeof process.env.ZOO_TASK_STORE === 'string' && process.env.ZOO_TASK_STORE !== ''
      ? process.env.ZOO_TASK_STORE
      : null;
  const store = fromFlag ?? fromEnv;

  if (store === null) {
    fail(
      'telemetry needs the runtime task store: pass --store=<tasks-dir> or set ZOO_TASK_STORE.\n' +
        '  VS Code (Linux): ~/.config/Code/User/globalStorage/<publisher>.<extension>/tasks\n' +
        '  It is read-only input; nothing is written there.',
    );
  }

  if (!existsSync(store)) {
    fail(`task store not found: ${store}`);
  }

  return resolve(store);
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const TELEMETRY_METRIC_SOURCES = {
  tokens_in: 'tokensIn',
  tokens_out: 'tokensOut',
  cache_reads: 'cacheReads',
  cache_writes: 'cacheWrites',
  cost: 'cost',
};

function readMetricLeaf(object, key) {
  if (!Object.hasOwn(object, key)) {
    return { state: 'not_recorded', value: null };
  }

  const value = object[key];

  if (value === null) {
    return { state: 'source_null', value: null };
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return { state: 'observed', value };
  }

  return { state: 'invalid', value: null };
}

function finishMetric(metric) {
  const observed = metric.observed;
  const total = observed.length === 0 ? null : observed.reduce((sum, value) => sum + value, 0);

  return {
    total,
    mean: total === null ? null : Number((total / observed.length).toFixed(6)),
    max: total === null ? null : Math.max(...observed),
    source_metric_counts: {
      records_enumerated: metric.recordsEnumerated,
      values_observed: metric.stateCounts.observed,
      values_source_null: metric.stateCounts.source_null,
      values_not_recorded: metric.stateCounts.not_recorded,
      values_invalid: metric.stateCounts.invalid,
    },
  };
}

/** Exact counts of the runtime's own message kinds. Nothing is inferred from message text. */
function summarizeRuntimeMessages(messages) {
  const kinds = {};
  const toolCalls = {};
  const requests = { request_envelopes_enumerated: 0, request_envelopes_parsed: 0, request_envelopes_malformed: 0 };
  const metrics = Object.fromEntries(
    Object.keys(TELEMETRY_METRIC_SOURCES).map((name) => [
      name,
      { recordsEnumerated: 0, stateCounts: { observed: 0, source_null: 0, not_recorded: 0, invalid: 0 }, observed: [] },
    ]),
  );
  const protocols = {};
  let firstTs = null;
  let lastTs = null;
  let subtaskResults = 0;

  const note = (name) => {
    toolCalls[name] = (toolCalls[name] ?? 0) + 1;
  };

  for (const message of messages) {
    const kind = message.type === 'say' ? message.say : message.type === 'ask' ? message.ask : null;
    const key = `${message.type ?? '?'}/${kind ?? '-'}`;
    kinds[key] = (kinds[key] ?? 0) + 1;

    if (typeof message.ts === 'number') {
      firstTs = firstTs === null ? message.ts : Math.min(firstTs, message.ts);
      lastTs = lastTs === null ? message.ts : Math.max(lastTs, message.ts);
    }

    if (kind === 'command') {
      note('execute_command');
    } else if (kind === 'tool') {
      note(parseMaybeJson(message.text)?.tool ?? 'unparsed');
    } else if (kind === 'subtask_result') {
      subtaskResults += 1;
    }

    if (kind === 'api_req_started') {
      requests.request_envelopes_enumerated += 1;
      const payload = parseMaybeJson(message.text);

      if (payload === null || Array.isArray(payload)) {
        requests.request_envelopes_malformed += 1;
        continue;
      }

      requests.request_envelopes_parsed += 1;

      for (const [name, sourceKey] of Object.entries(TELEMETRY_METRIC_SOURCES)) {
        const leaf = readMetricLeaf(payload, sourceKey);
        const metric = metrics[name];
        metric.recordsEnumerated += 1;
        metric.stateCounts[leaf.state] += 1;

        if (leaf.state === 'observed') {
          metric.observed.push(leaf.value);
        }
      }

      if (typeof payload.apiProtocol === 'string') {
        protocols[payload.apiProtocol] = (protocols[payload.apiProtocol] ?? 0) + 1;
      }
    }
  }

  return {
    kinds,
    tool_calls: toolCalls,
    tool_calls_total: Object.values(toolCalls).reduce((sum, value) => sum + value, 0),
    api_requests: {
      ...requests,
      metrics: Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, finishMetric(value)])),
    },
    api_protocols: protocols,
    max_tokens_in_single_request:
      metrics.tokens_in.observed.length === 0 ? null : Math.max(...metrics.tokens_in.observed),
    subtask_results_in_parent: subtaskResults,
    first_ts: firstTs === null ? null : new Date(firstTs).toISOString(),
    last_ts: lastTs === null ? null : new Date(lastTs).toISOString(),
    wall_clock_ms: firstTs === null || lastTs === null ? null : lastTs - firstTs,
  };
}

function parseMaybeJson(text) {
  if (typeof text !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Context sizes as stored. Character counts only — the runtime does not persist tokenised sizes. */
function summarizeContextHistory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const sizes = entries.map((entry) => contentChars(entry.content));
  const condensed = entries.filter(
    (entry) => entry.condenseParent !== undefined && entry.condenseParent !== null,
  ).length;

  return {
    entries: entries.length,
    chars_total: sizes.reduce((sum, size) => sum + size, 0),
    chars_first: sizes[0],
    chars_max: Math.max(...sizes),
    chars_mean: Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length),
    entries_with_condense_parent: condensed,
    units: 'characters (not tokens)',
  };
}

function contentChars(content) {
  if (typeof content === 'string') {
    return content.length;
  }

  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (typeof block?.text === 'string') {
        return sum + block.text.length;
      }

      return sum + JSON.stringify(block ?? null).length;
    }, 0);
  }

  return 0;
}

function telemetryForTaskDir(taskDir) {
  const messages = readJsonFile(join(taskDir, 'ui_messages.json'));
  const history = readJsonFile(join(taskDir, 'api_conversation_history.json'));
  const metadata = readJsonFile(join(taskDir, 'task_metadata.json'));

  const filesPresent = {
    ui_messages: Array.isArray(messages),
    api_conversation_history: Array.isArray(history),
    task_metadata: metadata !== null,
  };
  const acquisition = filesPresent.ui_messages
    ? { status: 'available', reason: null }
    : { status: 'unavailable', reason: 'ui_messages.json missing or unparseable in the telemetry store' };
  const observedMessages = acquisition.status === 'available' ? summarizeRuntimeMessages(messages) : null;

  const expected = {
    model_id: 'not recorded per request',
    provider_selection: 'settings-owned',
    per_command_duration_ms: 'not stored',
    tool_schema_size: 'not stored',
    system_prompt_chars: 'not persisted',
    turn_budget: 'no such runtime metric',
  };

  return {
    task_dir: taskDir,
    task_id: taskDir.split('/').filter(Boolean).pop(),
    files_present: filesPresent,
    acquisition,
    observed:
      acquisition.status === 'unavailable'
        ? null
        : {
            messages: observedMessages,
            context_history: filesPresent.api_conversation_history ? summarizeContextHistory(history) : null,
            context_files_tracked: filesPresent.task_metadata ? (metadata.files_in_context?.length ?? null) : null,
          },
    // Explicitly derived from observed values; kept separate so it can never be read as an observed metric.
    derived:
      observedMessages === null
        ? null
        : {
            cache_read_share_of_observed_prompt_tokens: ratio(
              observedMessages.api_requests.metrics.cache_reads.total,
              observedMessages.api_requests.metrics.tokens_in.total,
            ),
            mean_cost_per_observed_cost_leaf: ratio(
              observedMessages.api_requests.metrics.cost.total,
              observedMessages.api_requests.metrics.cost.source_metric_counts.values_observed,
            ),
          },
    unavailable_metrics: acquisition.status === 'available' ? expected : null,
  };
}

function cmdTelemetry(flags) {
  const store = resolveTaskStore(flags);
  const outPath =
    typeof flags.out === 'string'
      ? resolveExternalOutputPath(flags.out)
      : resolveControlPath(TELEMETRY_DIR, `${flags.scan === true ? 'scan' : 'task'}-${stamp()}.json`);

  if (flags.scan === true) {
    const dirs = existsSync(store)
      ? readdirSync(store, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(store, entry.name))
      : [];
    const summaries = dirs.map((dir) => {
      const summary = telemetryForTaskDir(dir);
      const messages = summary.observed?.messages ?? null;
      const requests = messages?.api_requests ?? null;

      return {
        task_id: summary.task_id,
        acquisition: summary.acquisition,
        api_requests:
          requests === null
            ? null
            : {
                request_envelopes_enumerated: requests.request_envelopes_enumerated,
                request_envelopes_parsed: requests.request_envelopes_parsed,
                request_envelopes_malformed: requests.request_envelopes_malformed,
              },
        tool_calls_total: messages?.tool_calls_total ?? null,
        wall_clock_ms: messages?.wall_clock_ms ?? null,
        first_ts: messages?.first_ts ?? null,
        metric_state_counts:
          requests === null
            ? null
            : Object.fromEntries(
                Object.entries(requests.metrics).map(([name, metric]) => {
                  const { records_enumerated: _recordsEnumerated, ...states } = metric.source_metric_counts;
                  return [name, states];
                }),
              ),
      };
    });

    const payload = {
      schema_version: 2,
      extracted_at: new Date().toISOString(),
      store,
      task_count: summaries.length,
      tasks: summaries.sort((left, right) => String(left.first_ts).localeCompare(String(right.first_ts))),
      note: 'Reader-enumerated runtime telemetry. Same-principal deletion, fabrication, and suppression remain possible.',
    };

    writeNewFileExclusive(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(
      `telemetry scan: ${payload.task_count} tasks in ${store}\n` +
        summaries
          .map(
            (item) =>
              `  ${item.task_id}  acquisition=${item.acquisition.status} envelopes=${item.api_requests?.request_envelopes_enumerated ?? '-'} tools=${item.tool_calls_total ?? '-'}`,
          )
          .join('\n') +
        `\nwritten: ${relative(outPath)}\n`,
    );

    return 0;
  }

  const raw = flags['task-dir'];

  if (typeof raw !== 'string') {
    fail('telemetry requires --task-dir=<id|path> or --scan (see: harness help)');
  }

  const taskDir = raw.includes('/') ? resolve(REPO_ROOT, raw) : join(store, raw);

  if (!existsSync(taskDir)) {
    fail(`task directory not found: ${taskDir}`);
  }

  const payload = { schema_version: 2, extracted_at: new Date().toISOString(), store, ...telemetryForTaskDir(taskDir) };

  writeNewFileExclusive(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  const messages = payload.observed?.messages ?? null;
  const requests = messages?.api_requests ?? null;

  process.stdout.write(
    [
      `telemetry: ${payload.task_id}`,
      `  acquisition:          ${payload.acquisition.status}${payload.acquisition.reason === null ? '' : ` (${payload.acquisition.reason})`}`,
      `  files present:        ${Object.entries(payload.files_present)
        .map(([name, present]) => `${name}=${present ? 'yes' : 'no'}`)
        .join(' ')}`,
      `  request envelopes:    ${requests?.request_envelopes_enumerated ?? 'n/a'} (parsed ${requests?.request_envelopes_parsed ?? 'n/a'}, malformed ${requests?.request_envelopes_malformed ?? 'n/a'})`,
      `  tokens in/out:        ${requests?.metrics.tokens_in.total ?? 'n/a'} / ${requests?.metrics.tokens_out.total ?? 'n/a'}`,
      `  cache reads/writes:   ${requests?.metrics.cache_reads.total ?? 'n/a'} / ${requests?.metrics.cache_writes.total ?? 'n/a'}`,
      `  cost:                 ${requests?.metrics.cost.total ?? 'n/a'}`,
      `  tool calls:           ${messages?.tool_calls_total ?? 'n/a'} ${JSON.stringify(messages?.tool_calls ?? {})}`,
      `  wall clock (ms):      ${messages?.wall_clock_ms ?? 'n/a'}`,
      `  context entries:      ${payload.observed?.context_history?.entries ?? 'n/a'} (${payload.observed?.context_history?.chars_total ?? 'n/a'} chars)`,
      `  condense events:      ${payload.observed?.context_history?.entries_with_condense_parent ?? 'n/a'}`,
      `  written:              ${relative(outPath)}`,
      '',
    ].join('\n'),
  );

  return 0;
}

function aggregateReportTelemetry(records) {
  const metricNames = Object.keys(TELEMETRY_METRIC_SOURCES);
  const metrics = Object.fromEntries(
    metricNames.map((name) => [
      name,
      {
        records_enumerated: 0,
        values_observed: 0,
        values_source_null: 0,
        values_not_recorded: 0,
        values_invalid: 0,
        total: null,
        max: null,
      },
    ]),
  );
  let schema2RecordsEnumerated = 0;
  let schema2Available = 0;
  let schema2Unavailable = 0;
  let historicalV1RecordsUninterpreted = 0;
  let notSuppliedRuns = 0;

  for (const record of records) {
    const telemetry = record.finished.telemetry;

    if (telemetry === null || telemetry === undefined) {
      notSuppliedRuns += 1;
      continue;
    }

    if (telemetry.schema_version !== 2) {
      historicalV1RecordsUninterpreted += 1;
      continue;
    }

    schema2RecordsEnumerated += 1;

    if (telemetry.status === 'unavailable') {
      schema2Unavailable += 1;
      continue;
    }

    if (telemetry.status !== 'available') {
      continue;
    }

    schema2Available += 1;
    const sourceMetrics = telemetry.observed?.api_requests?.metrics ?? {};

    for (const name of metricNames) {
      const source = sourceMetrics[name];

      if (source === undefined) {
        continue;
      }

      const target = metrics[name];
      const counts = source.source_metric_counts;
      target.records_enumerated += counts.records_enumerated;
      target.values_observed += counts.values_observed;
      target.values_source_null += counts.values_source_null;
      target.values_not_recorded += counts.values_not_recorded;
      target.values_invalid += counts.values_invalid;

      if (source.total !== null) {
        target.total = (target.total ?? 0) + source.total;
      }

      if (source.max !== null) {
        target.max = target.max === null ? source.max : Math.max(target.max, source.max);
      }
    }
  }

  for (const metric of Object.values(metrics)) {
    metric.mean =
      metric.values_observed === 0 || metric.total === null
        ? null
        : Number((metric.total / metric.values_observed).toFixed(6));
  }

  return {
    schema_2_records_enumerated: schema2RecordsEnumerated,
    schema_2_available: schema2Available,
    schema_2_unavailable: schema2Unavailable,
    historical_v1_records_uninterpreted: historicalV1RecordsUninterpreted,
    not_supplied_runs: notSuppliedRuns,
    metrics,
  };
}

function isAdverseNoGateObservation(finished) {
  return finished.verifier?.verdict === 'FAIL' || finished.verifier?.artifact_integrity === 'CHANGED';
}

/**
 * R6 — did a `regress` comparison ask for this run? Read from the run's OWN `run_origin`, which `regress` stamps on
 * both children. A run with no origin is an ordinary run, and an unparsable origin is "not comparison-sourced" rather
 * than a guess: disclosure may under-claim, never over-claim.
 */
function isComparisonSourcedRun(record) {
  const origin = record.started?.run_origin ?? record.finished?.run_origin ?? null;

  return typeof origin === 'string' && origin.startsWith(`${REGRESS_RUN_ORIGIN_KIND}:`);
}

function classifyReportPopulation(record) {
  const { started, finished, structuralValid, gateClassification } = record;

  if (!structuralValid) {
    return 'invalid_run_stream';
  }

  if (finished === null) {
    return 'unfinished';
  }

  if (started?.gate === null && !gateClassification.valid) {
    return 'invalid_run_stream';
  }

  const hasTerminalStructure =
    typeof started?.gate === 'string' &&
    started.gate === finished.gate &&
    Number.isInteger(finished.gate_exit_code) &&
    finished.gate_exit_code >= 0 &&
    finished.gate_exit_code <= 255 &&
    typeof finished.mechanically_verified === 'boolean' &&
    finished.mechanically_verified === (finished.gate_exit_code === 0) &&
    gateClassification.valid;

  if (hasTerminalStructure) {
    return 'terminal_evaluation';
  }

  if (finished.self_test === true) {
    return 'self_test';
  }

  if (finished.gate_incompatible === true) {
    return 'gate_incompatible';
  }

  const noGateFields = [
    'gate',
    'gate_exit_code',
    'mechanically_verified',
    'self_test',
    'agent_claimed_done',
    'acceptance_verified',
    'task_id',
    'duration_ms',
    'run_id',
  ];
  if (
    noGateFields.every((field) => Object.hasOwn(finished, field)) &&
    finished.gate === null &&
    finished.gate_exit_code === null &&
    finished.mechanically_verified === false &&
    !existsSync(resolveControlPath(RUNS_DIR, `${record.runId}.gate.log`))
  ) {
    return 'no_gate_observation';
  }

  return 'invalid_run_stream';
}

function cmdReport(flags) {
  const records = readRunRecords().map((record) => ({
    ...record,
    population: classifyReportPopulation(record),
  }));
  const outPath =
    typeof flags.out === 'string'
      ? resolveExternalOutputPath(flags.out)
      : resolveControlPath(RESULTS_DIR, `report-${stamp()}.json`);
  const byPopulation = (population) => records.filter((record) => record.population === population);
  // R6: `regress` is non-causal with respect to LEDGER terminal state, but each of its sides is an ordinary
  // gate-bearing `evaluate` run and IS part of this population. The claim "regress enters no denominator in report"
  // was false; the totals above are unchanged (no existing denominator is silently redefined), and the reader can
  // now see exactly how many of these runs came from a comparison.
  const comparisonSourced = records.filter((record) => isComparisonSourcedRun(record));
  const comparisonSourcedTerminal = comparisonSourced.filter((record) => record.population === 'terminal_evaluation');
  const comparisonSourcedRunIds = comparisonSourced.map((record) => record.runId).sort();
  const terminalEvaluations = byPopulation('terminal_evaluation');
  const noGateObservations = byPopulation('no_gate_observation');
  const selfTestRuns = byPopulation('self_test');
  const gateIncompatibleRuns = byPopulation('gate_incompatible');
  const unfinishedRuns = byPopulation('unfinished');
  const invalidRunStreams = byPopulation('invalid_run_stream');
  const historicalUnlabelled = invalidRunStreams.filter(
    (record) =>
      record.finished !== null &&
      ['gate', 'gate_exit_code', 'mechanically_verified'].every((field) => !Object.hasOwn(record.finished, field)),
  );
  const runIds = records.map((r) => r.runId).sort();
  const durations = terminalEvaluations.map((r) => r.finished.duration_ms).filter((d) => typeof d === 'number');
  const failureHits = {};

  for (const record of terminalEvaluations) {
    const category = record.finished.failure_category;

    if (category) {
      failureHits[category] = (failureHits[category] ?? 0) + 1;
    }
  }

  const perTask = [
    ...[...terminalEvaluations, ...noGateObservations]
      .reduce((map, record) => {
        const key = record.finished.task_id;
        const bucket = map.get(key) ?? {
          task_id: key,
          runs: 0,
          terminal_evaluations: 0,
          no_gate_observations: 0,
          adverse_no_gate_observations: 0,
          verified: 0,
          false_done: 0,
          acceptance_pass: 0,
        };
        const terminal = record.population === 'terminal_evaluation';

        bucket.runs += terminal ? 1 : 0;
        bucket.terminal_evaluations += terminal ? 1 : 0;
        bucket.no_gate_observations += terminal ? 0 : 1;
        bucket.adverse_no_gate_observations += !terminal && isAdverseNoGateObservation(record.finished) ? 1 : 0;
        bucket.verified += terminal && record.finished.mechanically_verified ? 1 : 0;
        bucket.false_done += terminal && record.finished.false_done ? 1 : 0;
        bucket.acceptance_pass += terminal && record.finished.acceptance_verified ? 1 : 0;
        map.set(key, bucket);

        return map;
      }, new Map())
      .values(),
  ].sort((a, b) => a.task_id.localeCompare(b.task_id));

  const aggregate = {
    generated_at: new Date().toISOString(),
    source: { runs_dir: relative(RUNS_DIR), run_files: runIds },
    gate_definition_sha256: GATE_DEFINITION_SHA,
    runs_total: records.length,
    runs_finished: terminalEvaluations.length + noGateObservations.length,
    terminal_evaluations: terminalEvaluations.length,
    no_gate_observations: noGateObservations.length,
    adverse_no_gate_observations: noGateObservations.filter((record) => isAdverseNoGateObservation(record.finished))
      .length,
    self_test_runs_excluded: selfTestRuns.length,
    // ADDITIVE and disclosed: the existing denominators above are UNCHANGED. A reader can subtract this to see the
    // comparison-free population, and the JSON report names every run it covers.
    comparison_sourced_runs: {
      kind: REGRESS_RUN_ORIGIN_KIND,
      runs: comparisonSourced.length,
      terminal_evaluations: comparisonSourcedTerminal.length,
      runs_included_in_the_denominators_above: true,
      run_files: comparisonSourcedRunIds,
      note: 'each `regress` side is an ordinary gate-bearing `evaluate` run, so it IS counted in runs_total, terminal_evaluations, mechanically_verified and verification_success_rate. regress is non-causal with respect to LEDGER terminal state only. Excluding these from the existing denominators would silently redefine report semantics, so they are DISCLOSED here instead and the denominators are left exactly as they were.',
    },
    gate_incompatible_runs: gateIncompatibleRuns.length,
    unfinished_runs: unfinishedRuns.length,
    invalid_run_streams: invalidRunStreams.length,
    historical_v1_records_uninterpreted: historicalUnlabelled.length,
    ledger_inventory: inspectLedgerInventory().map((entry) => ({
      run_id: entry.run_id,
      filename: entry.filename,
      classification: entry.classification,
      code: entry.code,
      diagnostics: entry.diagnostics,
      byte_length: entry.byteLength,
    })),
    ledger_state_quality: inspectLedgerInventory()
      .filter((entry) => entry.classification === 'operational_valid')
      .map((entry) => ({
        run_id: entry.ledger.run_id,
        task_id: entry.ledger.task_id,
        arm: entry.ledger.arm,
        status: entry.ledger.status,
        // Which commit each reported status is ABOUT, and which commit its ledger DECLARED. Both are reported
        // because they can differ; the report reads the durable record and observes no commit of its own.
        source_commit: entry.ledger.source_commit,
        judged_commit: judgedCommitDisplay(entry.ledger),
        // The environment observation travels with the row, joined the way the writer wrote it. P2: this used to join
        // `environments[].run_id` (an EVALUATION run id) against `ledger.run_id` (the LEDGER id) — two namespaces that
        // are never equal — so every row read `null` and the printed line claimed a durable record it had never read.
        // It is reported alongside both commits and never merged with either: the declared commit, the observed commit
        // and the environment are three separate facts. No environment record still reports `null` — "not recorded".
        environment: newestEnvironmentRecord(entry.ledger),
        issues: ledgerStateQuality(entry.ledger, resolve(REPO_ROOT, entry.ledger.workspace)).map((issue) => issue.kind),
      })),
    mechanically_verified: terminalEvaluations.filter((r) => r.finished.mechanically_verified).length,
    agent_claimed_done: terminalEvaluations.filter((r) => r.finished.agent_claimed_done).length,
    false_done: terminalEvaluations.filter((r) => r.finished.false_done).length,
    acceptance_pass: terminalEvaluations.filter((r) => r.finished.acceptance_verified).length,
    false_done_rate: ratio(
      terminalEvaluations.filter((r) => r.finished.false_done).length,
      terminalEvaluations.filter((r) => r.finished.agent_claimed_done).length,
    ),
    verification_success_rate: ratio(
      terminalEvaluations.filter((r) => r.finished.mechanically_verified).length,
      terminalEvaluations.length,
    ),
    failure_categories: failureHits,
    duration_ms: {
      total: durations.reduce((a, b) => a + b, 0),
      mean: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    },
    runtime_metrics_coverage: {
      runs_with_any_metric: terminalEvaluations.filter((r) => Object.keys(r.finished.runtime_metrics ?? {}).length > 0)
        .length,
      runs_without_any_metric: terminalEvaluations.filter(
        (r) => Object.keys(r.finished.runtime_metrics ?? {}).length === 0,
      ).length,
    },
    telemetry: aggregateReportTelemetry(terminalEvaluations),
    per_task: perTask,
  };

  writeNewFileExclusive(outPath, `${JSON.stringify(aggregate, null, 2)}\n`);

  process.stdout.write(
    [
      '',
      `runs:                  ${aggregate.runs_total} (finished: ${aggregate.runs_finished}, self-test excluded: ${aggregate.self_test_runs_excluded})`,
      `terminal evaluations:   ${aggregate.terminal_evaluations}`,
      `comparison-sourced:     ${aggregate.comparison_sourced_runs.runs} run(s) (${aggregate.comparison_sourced_runs.terminal_evaluations} terminal) came from a \`regress\` comparison and ARE included in every denominator above`,
      `                       (regress is non-causal for LEDGER terminal state only; the denominators are unchanged and these are disclosed, not removed)`,
      `no-gate observations:  ${aggregate.no_gate_observations} (adverse: ${aggregate.adverse_no_gate_observations})`,
      `unfinished / invalid:  ${aggregate.unfinished_runs} / ${aggregate.invalid_run_streams}`,
      `mechanically verified: ${aggregate.mechanically_verified}/${aggregate.terminal_evaluations}`,
      `agent claimed done:    ${aggregate.agent_claimed_done}`,
      `false_done:            ${aggregate.false_done} (rate ${formatRate(aggregate.false_done_rate)})`,
      `acceptance pass:       ${aggregate.acceptance_pass}`,
      `mean duration:         ${aggregate.duration_ms.mean ?? '-'} ms`,
      `failure categories:    ${Object.keys(failureHits).length === 0 ? '(none)' : JSON.stringify(failureHits)}`,
      '',
      `ledgers reported:      ${aggregate.ledger_state_quality.length}`,
      ...(aggregate.ledger_state_quality.length === 0
        ? ['judged commits:      (none — no operational ledger in this report)']
        : [
            `judged commits:      ${aggregate.ledger_state_quality.filter((row) => row.judged_commit !== null && row.judged_commit.observed_commit !== null).length}/${aggregate.ledger_state_quality.length} ledgers record an OBSERVED judged commit`,
            '                     (read from the durable evaluations[] record; this report observes no commit itself)',
            ...aggregate.ledger_state_quality
              .slice(0, 20)
              .map(
                (row) =>
                  `  - ${row.task_id} ${row.arm ?? 'unlabelled'}: judged ${row.judged_commit?.observed_commit ?? '(none recorded)'} · declared ${row.source_commit}`,
              ),
            ...(aggregate.ledger_state_quality.length > 20
              ? [`  (${aggregate.ledger_state_quality.length - 20} more; the JSON report has every one)`]
              : []),
          ]),
      ...(aggregate.ledger_state_quality.length === 0
        ? ['environments:         (none — no operational ledger in this report)']
        : [
            `environments:         ${aggregate.ledger_state_quality.filter((row) => row.environment !== null).length}/${aggregate.ledger_state_quality.length} ledgers record an OBSERVED environment`,
            '                     (counted from each ledger file on disk: the environments[] entry whose run_id matches',
            "                      that ledger's newest evaluations[] entry; a worktree is not a security boundary and",
            '                      historical reproducibility is not result authenticity)',
            ...aggregate.ledger_state_quality
              .slice(0, 20)
              .map(
                (row) =>
                  `  - ${row.task_id} ${row.arm ?? 'unlabelled'}: ${row.environment === null ? 'environment not recorded' : `${row.environment.dependency_provisioning} (${row.environment.dependency_provisioning_basis}); digest ${row.environment.installed_state_digest ?? '(none)'}`}`,
              ),
          ]),
      '',
      `written:               ${relative(outPath)}`,
      '',
    ].join('\n'),
  );

  return 0;
}

function readRunRecords() {
  if (!existsSync(RUNS_DIR)) {
    return [];
  }

  return readdirSync(RUNS_DIR)
    .filter((file) => file.endsWith('.jsonl') && RUN_TOKEN_RE.test(file.replace(/\.jsonl$/, '')))
    .map((file) => {
      const runId = file.replace(/\.jsonl$/, '');
      const eventsPath = resolveControlPath(RUNS_DIR, file);

      if (!lstatSync(eventsPath).isFile()) {
        throw new Error(`run stream is not a regular file: ${eventsPath}`);
      }

      let structurallyValid = true;
      const events = readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            const event = JSON.parse(line);

            if (event === null || typeof event !== 'object' || Array.isArray(event)) {
              structurallyValid = false;
            }

            return event;
          } catch {
            structurallyValid = false;
            return { event: 'unparsable' };
          }
        });
      const startedEvents = events.filter((event) => event?.event === 'run_started');
      const finishedEvents = events.filter((event) => event?.event === 'run_finished');
      const started = startedEvents[0] ?? null;
      const finished = finishedEvents[0] ?? null;

      if (startedEvents.length !== 1 || finishedEvents.length > 1) {
        structurallyValid = false;
      }

      for (const event of events) {
        if (Object.hasOwn(event, 'run_id') && event.run_id !== runId) {
          structurallyValid = false;
        }

        if (event?.event === 'run_finished' && event.task_id !== started?.task_id) {
          structurallyValid = false;
        }
      }

      const gatePath = resolveControlPath(RUNS_DIR, `${runId}.gate.log`);
      const expectedSteps =
        started?.gate === null || started?.gate === undefined
          ? []
          : (GATES[started.gate] ?? [])
              .slice(0, finished?.steps?.length ?? 0)
              .map((step) => ({ step: step.step, command: formatCommand(step) }));
      const gateClassification =
        started?.gate === null || started?.gate === undefined
          ? existsSync(gatePath)
            ? { valid: false, reason: 'unexpected_gate_log' }
            : { valid: true, reason: null }
          : !existsSync(gatePath)
            ? { valid: false, reason: 'missing' }
            : classifyGateLog(readFileSync(gatePath, 'utf8'), expectedSteps);

      return {
        runId,
        events,
        started,
        finished,
        structuralValid: structurallyValid,
        gateClassification,
      };
    });
}

// ---------------------------------------------------------------- repo + runtime facts

/**
 * Commit-bound evaluation records. Pure helpers first (so the self-tests can exercise them directly), then the two
 * thin git wrappers that observe a workspace the gate actually ran in.
 */

/** A commit is recorded full or not at all: an abbreviation is what makes two commits confusable. */
function normalizeCommitSha(value) {
  const text = typeof value === 'string' ? value.trim() : '';

  return JUDGED_COMMIT_RE.test(text) ? text : null;
}

/** Every optional observation lands here on the way into the ledger: absent becomes `null`, never ''. */
function hexOrNull(value, pattern) {
  const text = typeof value === 'string' ? value.trim() : '';

  return pattern.test(text) ? text : null;
}

function optionalTextOrNull(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null;
}

/** Deterministic serialisation: object keys sorted recursively, so a digest cannot depend on key order. */
function canonicalJson(value) {
  if (value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/**
 * Bind a result to the criteria that judged it. The input is what actually decides a run: the acceptance criteria, the
 * mechanical checks, the criterion boundaries, AND the RESOLVED gate name (adversarial correction C3). A digest over
 * `acceptance` alone is constant across two runs that judged differently whenever `acceptance_checks` were edited or the
 * gate selection changed — which would produce a false "same contract" comparison.
 */
function contractDigest(task, resolvedGateName) {
  const payload = canonicalJson({
    acceptance: task?.acceptance ?? [],
    acceptance_boundaries: task?.acceptance_boundaries ?? [],
    acceptance_checks: task?.acceptance_checks ?? [],
    gate: resolvedGateName ?? null,
  });

  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Which tree was judged, in three values (C10). `workspaceGitDir === workspaceCommonDir` is the primary checkout of that
 * repository; a different git dir under the same common dir is a LINKED WORKTREE of it; a different common dir is an
 * unrelated tree whose commits mean nothing in this ledger. Unresolvable input is `null`, never a guess.
 */
function resolveJudgedScope({ workspaceCommonDir, workspaceGitDir, ownCommonDir }) {
  if (
    typeof workspaceCommonDir !== 'string' ||
    typeof workspaceGitDir !== 'string' ||
    typeof ownCommonDir !== 'string' ||
    workspaceCommonDir === '' ||
    workspaceGitDir === '' ||
    ownCommonDir === ''
  ) {
    return null;
  }

  if (resolve(workspaceCommonDir) !== resolve(ownCommonDir)) {
    return 'unrelated_tree';
  }

  return resolve(workspaceGitDir) === resolve(workspaceCommonDir) ? 'primary_repo' : 'linked_worktree_of_this_repo';
}

/** `git rev-parse` answers with paths that may be relative to the queried directory; resolve them against it. */
function observedGitDirs(cwd) {
  const read = (args) => {
    const raw = git(args, cwd);

    if (raw === null) {
      return null;
    }

    const text = raw.trim();

    return text === '' ? null : isAbsolute(text) ? text : resolve(cwd, text);
  };

  return {
    commonDir: read(['rev-parse', '--git-common-dir']),
    gitDir: read(['rev-parse', '--absolute-git-dir']),
  };
}

/**
 * One observation of the tree that is about to be judged (pre-gate) or that just was (post-gate). Every field is
 * nullable by construction: a `.git` that exists but is not a gitdir still satisfies the `evaluate` precondition, and a
 * failed git call must become `null` rather than an empty string the reader would have to special-case.
 */
function observeJudgedTree(cwd) {
  const status = git(['status', '--porcelain'], cwd);
  const dirs = observedGitDirs(cwd);

  return {
    commit: normalizeCommitSha(git(['rev-parse', 'HEAD'], cwd)),
    scope: resolveJudgedScope({
      workspaceCommonDir: dirs.commonDir,
      workspaceGitDir: dirs.gitDir,
      ownCommonDir: observedGitDirs(REPO_ROOT).commonDir,
    }),
    statusHash: status === null ? null : createHash('sha256').update(status).digest('hex').slice(0, 12),
    // A SECOND hash over the SAME observation, with the harness's own control state and the other established noise
    // paths removed. `status_hash_pre` above is a fact about `git status` and nothing else, and `.harness/` is
    // UNTRACKED in this repository, so every run this program performs adds a run stream and CHANGES that hash. A
    // key built on it therefore puts every run of the same commit in its own group, forever.
    sourceStatusHash:
      status === null
        ? null
        : createHash('sha256')
            .update(
              status
                .split('\n')
                .filter((line) => line.trim() !== '')
                .filter((line) => !isNoisePath(line.slice(3).trim()))
                .join('\n'),
            )
            .digest('hex')
            .slice(0, 12),
  };
}

/** The dependency confound made visible: `prepare-workspace.sh` USED TO link today's dependencies, so it is not derivable. */
function observeLockfileDigest(cwd) {
  const absolute = join(cwd, EVALUATIONS_LOCKFILE);

  if (!existsSync(absolute)) {
    return null;
  }

  try {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Build one `evaluations[]` entry. Every optional observation is normalised to `null` HERE, on the write side, which is
 * what removes the writer/reader disagreement by construction (C1). This entry is a record of one invocation, never a
 * reproduction recipe: it does not establish reproducibility, determinism, dependency fidelity or evaluator fidelity.
 */
function buildEvaluationEntry({ at, runId, task, gateName, workspacePath, pre, post }) {
  return {
    at,
    run_id: runId,
    // The declaration travels with the observation, read from the contract THIS run judged by.
    declared_source_commit: hexOrNull(task?.source_commit, LEDGER_GIT_HEX_RE),
    judged_commit_pre: normalizeCommitSha(pre?.commit),
    judged_commit_post: normalizeCommitSha(post?.commit),
    judged_commit_basis: 'observed',
    judged_commit_scope: JUDGED_COMMIT_SCOPES.includes(pre?.scope) ? pre.scope : null,
    judged_cwd: optionalTextOrNull(recordedCwd(workspacePath), 1024),
    status_hash_pre: hexOrNull(pre?.statusHash, DIGEST_12_RE),
    status_hash_post: hexOrNull(post?.statusHash, DIGEST_12_RE),
    // `gate` is nullable for the same reason every other observation is: the writer normalises, and the reader
    // accepts `null`. A gate name that is absent, blank or longer than the reader's bound becomes `null` HERE
    // rather than being written as a shape the strict reader would refuse on the NEXT read (which fails closed
    // and would brick the ledger). `resolveGateName` normally guarantees a `GATES` key, so this is a bound, not
    // an expected path.
    gate: optionalTextOrNull(gateName, 120),
    gate_definition_sha256: hexOrNull(GATE_DEFINITION_SHA, DIGEST_16_RE),
    contract_digest: hexOrNull(contractDigest(task, gateName), DIGEST_16_RE),
    lockfile_digest: hexOrNull(observeLockfileDigest(workspacePath ?? REPO_ROOT), DIGEST_12_RE),
    acceptance_contract_schema_version:
      Number.isInteger(task?.schema_version) && task.schema_version > 0 ? task.schema_version : null,
  };
}

/**
 * Append one entry to the additive, non-causal `evaluations[]` array. It is written in the SAME conditional that appends
 * `verification[]` (a gate-bearing, gate-compatible, ledger-attached run), so a no-gate, gate-incompatible or unledgered
 * run never produces one and can never trigger a state-quality kind.
 *
 * The array is bounded like every sibling array. The bound is enforced HERE, not only on read, because a write that the
 * reader would later refuse does not fail at write time — it bricks the ledger on the next load.
 */
function appendEvaluation(ledger, entry) {
  const existing = ledger.evaluations ?? [];

  if (existing.length >= EVALUATIONS_MAX_ENTRIES) {
    throw new Error(
      `EVALUATIONS_CAPACITY_EXCEEDED: evaluations[] already holds ${existing.length} entries (max ${EVALUATIONS_MAX_ENTRIES})`,
    );
  }

  ledger.evaluations = [...existing, entry];
}

// ---------------------------------------------------------------- environment provenance (P2a) and historical workspace (P1)
//
// ONE standard is applied to declared-vs-observed throughout this section (D11/D12):
//   * a value this local program computed by looking is `observed` — "this program looked", NOT "a lie requires a writer";
//   * a value npm REPORTS about what it did (its own `.package-lock.json`) is `declared by npm` with a basis, because
//     nothing here verifies npm's account of itself;
//   * a value read from a manifest, a lockfile or a flag is `declared`, and a declaration is never promoted to an
//     observation;
//   * a field that reads like a containment guarantee states containment and nothing more. A worktree is a place on a
//     filesystem; it is not a security boundary, and historical reproducibility is not result authenticity (AGENTS.md,
//     "Permanent harness limitation").

/** Truncated 16-hex identity digest. A digest is a different animal from a commit sha and is truncated everywhere. */
function digest16(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function digest12(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function digestFile16(path) {
  try {
    return existsSync(path) ? digest16(readFileSync(path)) : null;
  } catch {
    return null;
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Path containment, resolved first: a string prefix is not containment. */
function isContainedBy(child, parent) {
  const from = resolve(parent);
  const to = resolve(child);

  return to === from || to.startsWith(`${from}${sep}`);
}

/**
 * C1, mechanical. "The worktree is outside the repository" is a POLICY, not a guarantee: the root is derived from
 * `HARNESS_WORKTREE_ROOT` / `XDG_CACHE_HOME` / `HOME`, all operator-controlled, and an out-of-repo root can still
 * inherit `$HOME/node_modules` through exactly the same upward resolution. So containment is measured instead of
 * assumed — from the root's PARENT up to `/`, `lstat` a `node_modules` child at every ancestor and refuse if one exists.
 */
function ancestorNodeModulesRefusal(root) {
  let current = dirname(resolve(root));

  while (true) {
    const candidate = join(current, 'node_modules');
    let stat = null;

    try {
      stat = lstatSync(candidate);
    } catch {
      stat = null;
    }

    if (stat !== null) {
      return {
        path: candidate,
        ancestor: current,
        kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other',
      };
    }

    if (current === sep) {
      return null;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveWorkspaceRoot(source = process.env) {
  const override =
    typeof source.HARNESS_WORKTREE_ROOT === 'string' && source.HARNESS_WORKTREE_ROOT.trim() !== ''
      ? source.HARNESS_WORKTREE_ROOT
      : null;

  if (override !== null) {
    return { path: resolve(override), source: 'env_override' };
  }

  const xdg =
    typeof source.XDG_CACHE_HOME === 'string' && source.XDG_CACHE_HOME.trim() !== '' ? source.XDG_CACHE_HOME : null;

  if (xdg !== null) {
    return { path: resolve(xdg, WORKSPACE_ROOT_RELATIVE), source: 'xdg_cache_home' };
  }

  const home = typeof source.HOME === 'string' && source.HOME.trim() !== '' ? source.HOME : null;

  if (home !== null) {
    return { path: resolve(home, '.cache', WORKSPACE_ROOT_RELATIVE), source: 'home_cache' };
  }

  // Never a repository-internal fallback: that is the topology this increment exists to remove.
  return null;
}

/**
 * C1, all three refusals. The root is derived from operator-controlled variables, so "outside the repository" is a
 * policy, not a guarantee — and even a genuinely out-of-repo root can inherit `$HOME/node_modules` through exactly
 * the same upward resolution. So: refuse a root that IS or is contained by `REPO_ROOT`, refuse a non-canonical or
 * symlinked root (reusing the discipline the control plane already applies), and refuse any root with a
 * `node_modules` in a strict ancestor.
 */
function assertWorkspaceRootRefusals(root) {
  if (isContainedBy(root, REPO_ROOT)) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `WORKTREE_ROOT_INSIDE_REPOSITORY: ${root} ${resolve(root) === REPO_ROOT ? 'is' : 'is contained by'} REPO_ROOT (${REPO_ROOT}) — Node resolves node_modules upward, so a root under the repository inherits the repository's dependencies with zero setup`,
    );
  }

  assertNoSymlinkComponents(root);

  const ancestor = ancestorNodeModulesRefusal(root);

  if (ancestor !== null) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `ANCESTOR_NODE_MODULES: ${ancestor.path} (${ancestor.kind}) exists above the worktree root — Node's upward module resolution would silently inherit it. Move the root, or remove that directory.`,
    );
  }

  return true;
}

/**
 * A5 — the npm cache is a PATH INPUT and gets the same placement refusal the worktree root gets.
 *
 * `--npm-cache=<dir>` and `HARNESS_NPM_CACHE` were the one path input with no placement guard, so
 * `--npm-cache=./.harness/cache` created a directory inside the repository (verified: exit 0). Nothing is written
 * into the judge's tree by accident here, but a cache inside the repository is untracked noise that `status_hash`
 * observes, an inherited `node_modules`-shaped hazard for a future reader, and a path the containment argument above
 * this command claims to have checked. The refusal is the same class as the worktree root's, and it happens BEFORE
 * any directory is created.
 */
function assertNpmCacheRefusal(cachePath) {
  if (cachePath === null) {
    return;
  }

  if (isContainedBy(cachePath, REPO_ROOT)) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `NPM_CACHE_PLACEMENT_REFUSED: the npm cache ${cachePath} is inside the repository ${REPO_ROOT}. A cache is operator state, not part of any judged tree: putting it under the repository makes untracked noise that git status --porcelain observes, which is exactly the signal a tree_moved decision reads. Point --npm-cache/HARNESS_NPM_CACHE outside the repository (HARNESS_WORKTREE_ROOT's parent is the natural neighbour).`,
    );
  }
}

function workspaceFail(exitCode, message) {
  const error = new Error(message);

  error.code = 'HARNESS_WORKSPACE_REFUSED';
  error.exitCode = exitCode;
  throw error;
}

/**
 * C11, named and recorded. These variables can silently supply a module or redirect package acquisition, so the child
 * environment the harness constructs never inherits them:
 *   * `NODE_PATH` / `NODE_OPTIONS` — inject modules the install did not provide. `NODE_PATH` alone can satisfy any
 *     `require`, invisibly to every other field. REFUSED, or explicitly accepted and recorded.
 *   * every `npm_config_*` / `NPM_CONFIG_*` — npm exports ~18 of them when the harness itself is launched through npm,
 *     so inheriting them would make the recorded environment a function of how the command was invoked. DROPPED, and
 *     the harness sets the small allowlist it names itself.
 *   * proxies — affect acquisition, which npm integrity-checks, but cannot be reproduced deterministically. DROPPED and
 *     recorded by name (values are never stored).
 */
const ENV_REFUSED_NAMES = ['NODE_OPTIONS', 'NODE_PATH'];
const ENV_PROXY_NAMES = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];
/**
 * THERE IS NO npm_config ALLOWLIST, and there is deliberately no list of npm_config variables to name here.
 *
 * The previous constant `ENV_ALLOWLISTED_NPM_CONFIG` named five of them and was referenced by NOTHING: the sanitiser
 * below drops EVERY `npm_config_*`/`NPM_CONFIG_*` key by pattern, before any per-name decision is reached. A constant
 * called an ALLOWLIST that nothing consults is worse than no constant — a reader (and a future editor) reasonably
 * concludes those five survive, which is the exact opposite of what the code does. The behaviour itself is right and
 * is unchanged: an npm config variable can redirect the registry, the cache or a script path, so the constructed child
 * environment carries none of them. What the record states instead is the POLICY and the digest of the environment this
 * harness actually constructed.
 */

function constructChildEnv({ source = process.env, extra = {}, refuse = false, accepted = [] } = {}) {
  const env = {};
  const excluded = [];
  const refused = [];
  const removed = [];
  const kept = [];

  for (const [key, value] of Object.entries(source)) {
    if (/^npm_config_/i.test(key) || /^NPM_CONFIG_/i.test(key)) {
      excluded.push(key);
      continue;
    }

    if (ENV_PROXY_NAMES.includes(key)) {
      excluded.push(key);
      continue;
    }

    if (ENV_REFUSED_NAMES.includes(key)) {
      if (accepted.includes(key)) {
        env[key] = value;
        kept.push(key);
        continue;
      }

      if (refuse) {
        refused.push(key);
        continue;
      }

      removed.push(key);
      continue;
    }

    env[key] = value;
  }

  if (refused.length > 0) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `INHERITED_ENV_REFUSED: ${refused.sort().join(', ')} — ${refused.includes('NODE_PATH') ? 'NODE_PATH can silently supply any package the install did not provide' : 'these variables are not part of the environment this harness constructs'}. Re-run with --accept-inherited-env=${refused.sort().join(',')} to record the acceptance as a bounded deviation.`,
    );
  }

  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }

  return {
    env,
    excluded: [...new Set(excluded)].sort(),
    refused: [],
    removed: [...new Set(removed)].sort(),
    accepted: [...new Set(kept)].sort(),
  };
}

function npmConfigSubset(env) {
  const keys = Object.keys(env)
    .filter((key) => /^npm_config_/i.test(key))
    .sort();

  return { count: keys.length, keys, digest: digest16(canonicalJson(keys)) };
}

function envFacts(env, meta = {}) {
  const excluded = meta.excluded ?? [];
  const removed = meta.removed ?? [];
  const accepted = meta.accepted ?? [];
  const npmConfig = npmConfigSubset(env);

  return {
    vars_digest: digest16(
      Object.keys(env)
        .sort()
        .map((key) => `${key}=${env[key]}`)
        .join('\n'),
    ),
    count: Object.keys(env).length,
    // The names npm_config_* the harness itself set. Values are never recorded: one of them can carry a token.
    allowlist_digest: npmConfig.digest,
    allowlist_count: npmConfig.count,
    excluded_names: excluded.slice(0, 20),
    excluded_digest: excluded.length === 0 ? null : digest16(canonicalJson([...excluded].sort())),
    module_resolution_vars_removed: removed.slice(0, 10),
    module_resolution_vars_accepted: accepted.slice(0, 10),
  };
}

function probePackageManagerVersion(childEnv) {
  return (run('npm', ['-v'], { silent: true, env: childEnv }).stdout ?? '').trim();
}

function packageManagerRecord({ version, declaredField }) {
  const name = version === '' ? null : 'npm';
  const declared = optionalTextOrNull(declaredField, 200);
  const declaredName = declared === null ? null : (/^([A-Za-z0-9._-]+)@/.exec(declared)?.[1] ?? null);
  const conflict = name !== null && declaredName !== null && declaredName !== name;

  return {
    name,
    version: optionalTextOrNull(version, 64),
    resolved_from: name === null ? null : 'path_probe',
    declared_field: declared,
    declared_field_honoured: name === null ? null : declaredName !== null && declaredName === name,
    declared_field_conflict: name === null ? null : conflict,
  };
}

function observeNode(packageJson) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(process.version);
  const engines = optionalTextOrNull(packageJson?.engines?.node, 200);

  return {
    version: optionalTextOrNull(process.version, 64),
    major: match === null ? null : Number(match[1]),
    minor: match === null ? null : Number(match[2]),
    patch: match === null ? null : Number(match[3]),
    // DECLARED by the judged commit, and `engines` is only a warning by default, so the satisfaction is COMPUTED here
    // and stays `null` whenever the range is not a form this implementation actually evaluates.
    engines_node: engines,
    engines_satisfied: engines === null || match === null ? null : enginesSatisfied(engines, process.version),
    engine_strict: null,
  };
}

/** A deliberately small range evaluator. Anything it does not understand returns `null`, never a guess. */
function enginesSatisfied(range, version) {
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (actual === null) {
    return null;
  }

  const target = [Number(actual[1]), Number(actual[2]), Number(actual[3])];
  const compare = (left, right) =>
    left[0] !== right[0] ? left[0] - right[0] : left[1] !== right[1] ? left[1] - right[1] : left[2] - right[2];

  for (const clause of range
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part !== '')) {
    let satisfied = true;

    for (const term of clause.split(/\s+/).filter((entry) => entry !== '')) {
      const match = /^(>=|<=|>|<|\^|~|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(term);

      if (match === null) {
        return null;
      }

      const wildcard = (value) => value === undefined || value === 'x' || value === '*';
      const major = wildcard(match[2]) ? null : Number(match[2]);
      const minor = wildcard(match[3]) ? null : Number(match[3]);
      const patch = wildcard(match[4]) ? null : Number(match[4]);

      if (major === null) {
        continue;
      }

      const floor = [major, minor ?? 0, patch ?? 0];
      const operator = match[1] ?? '=';

      if (operator === '>=') {
        satisfied &&= compare(target, floor) >= 0;
      } else if (operator === '>') {
        satisfied &&= compare(target, floor) > 0;
      } else if (operator === '<=') {
        satisfied &&= compare(target, floor) <= 0;
      } else if (operator === '<') {
        satisfied &&= compare(target, floor) < 0;
      } else if (operator === '^') {
        satisfied &&= compare(target, floor) >= 0 && target[0] === major;
      } else if (operator === '~') {
        satisfied &&= compare(target, floor) >= 0 && target[0] === major && target[1] === (minor ?? 0);
      } else {
        satisfied &&= compare(target, floor) === 0;
      }
    }

    if (satisfied) {
      return true;
    }
  }

  return false;
}

/**
 * The installed tree, as this local program can see it. `installed_state_digest` is a DECLARATION BY NPM of what it
 * installed (`node_modules/.package-lock.json` is npm's own record), labelled as such — it is not an independent
 * observation of the bytes, and it cannot see native build output. The `resolver_probe` below is the field that turns
 * "what I saw in the directory" into "what the resolver actually chose".
 */
function observeInstalledState(workspacePath) {
  const root = safeRealpath(workspacePath);
  const modules = join(workspacePath, 'node_modules');
  const result = {
    topology: 'missing',
    scope: 'none',
    realpath: null,
    entry_count: null,
    entry_count_raw: null,
    entry_count_excluded: null,
    state_digest: null,
    state_digest_source: null,
  };
  const ancestor = () => {
    const found = ancestorNodeModulesRefusal(workspacePath);

    if (found !== null) {
      result.scope = 'inherited_upward';
    }
  };
  let stat = null;

  try {
    stat = lstatSync(modules);
  } catch {
    stat = null;
  }

  if (stat === null) {
    ancestor();
    return result;
  }

  if (stat.isSymbolicLink()) {
    result.topology = 'symlink';
    result.scope = 'escapes_worktree';
    result.realpath = safeRealpath(modules);
    return result;
  }

  if (!stat.isDirectory()) {
    result.topology = 'partial';
    ancestor();
    return result;
  }

  const real = safeRealpath(modules);

  result.realpath = real;
  result.scope = root !== null && real !== null && isContainedBy(real, root) ? 'worktree_local' : 'escapes_worktree';

  // The DECLARED exclusion set applies to this count too, and it has to: the count is a reuse condition, so a count
  // that moves because a gate run wrote `node_modules/.cache` would refuse a workspace the digest considers unchanged
  // — the same contradiction the walk exclusion exists to remove, in the second of the two places it appeared. The
  // raw count is recorded beside the attested one, so nothing is hidden and the two can be reconciled.
  try {
    const listing = readdirSync(modules);
    const excluded = listing.filter((name) => INSTALLED_TREE_EXCLUSION_RE.test(name));

    result.entry_count = listing.length - excluded.length;
    result.entry_count_raw = listing.length;
    result.entry_count_excluded = excluded.sort();
  } catch {
    result.entry_count = null;
    result.entry_count_raw = null;
    result.entry_count_excluded = null;
  }

  const digest = digestFile16(join(modules, '.package-lock.json'));

  result.state_digest = digest;
  result.state_digest_source = digest === null ? null : 'node_modules_package_lock';
  result.topology = digest !== null && (result.entry_count ?? 0) > 0 ? 'real_directory' : 'partial';

  return result;
}

/**
 * A content hash of one file, read in bounded chunks. Returns `null` rather than throwing: an unreadable file makes
 * the whole fingerprint unavailable, and the caller FAILS CLOSED on `null` rather than degrading to a weaker claim.
 */
function hashFileBytes16(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1 << 20);
  let fd = null;

  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }

  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);

      if (read <= 0) {
        break;
      }

      hash.update(buffer.subarray(0, read));
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  return hash.digest('hex').slice(0, 16);
}

/**
 * A COUNT-ONLY walk of one excluded subtree. It reads DIRECTORY NAMES and counts them; it never opens a file, never
 * hashes a byte and never records what it found. That is the whole point: quantifying the population the exclusion
 * leaves unattested must not itself turn into an observation of the bytes the exclusion declines to attest.
 */
function countTreeEntries(root, maxEntries = BUILD_STATE_MAX_ENTRIES, maxDepth = BUILD_STATE_MAX_DEPTH) {
  let count = 0;
  let bounded = false;
  const walk = (directory, depth) => {
    if (bounded) {
      return;
    }

    if (depth > maxDepth) {
      bounded = true;
      return;
    }

    let listing = null;

    try {
      listing = readdirSync(directory, { withFileTypes: true });
    } catch {
      bounded = true;
      return;
    }

    for (const item of listing) {
      count += 1;

      if (count > maxEntries) {
        bounded = true;
        return;
      }

      if (item.isDirectory()) {
        walk(join(directory, item.name), depth + 1);
      }
    }
  };

  walk(root, 0);

  return { entries: count, bounded };
}

/**
 * The installed TREE, walked by this program. Deliberately NOT part of `observeInstalledState`: that function runs on
 * the PRIMARY checkout (912 MB, 54 744 files) on every `evaluate`, and a default full walk there would tax every
 * ordinary run to answer a question only the historical-workspace path asks.
 *
 * Returns `null` when the tree cannot be walked at all — the caller treats `null` as NOT REUSABLE / NOT USABLE. There
 * is deliberately no cheap fallback to a weaker tier: a silent downgrade is exactly how a false green returns.
 *
 * A symlink is RECORDED BY ITS LINK TARGET and never traversed, so a `file:` directory dependency installs as a symlink
 * and the walk sees the link, not the target's bytes. That is a real, documented limit of the content tier (F6).
 */
function observeInstalledTreeFingerprint(workspacePath, tier = TREE_FINGERPRINT_DEFAULT_TIER) {
  if (!TREE_FINGERPRINT_TIERS.includes(tier)) {
    return null;
  }

  const root = join(workspacePath, 'node_modules');
  const lines = [];
  let entries = null;

  try {
    const stat = lstatSync(root);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const excluded = new Set();
  let excludedEntries = 0;
  let excludedEntriesBounded = false;
  const walk = (directory) => {
    let listing = null;

    try {
      listing = readdirSync(directory, { withFileTypes: true });
    } catch {
      entries = -1;
      return;
    }

    for (const item of listing) {
      const absolute = join(directory, item.name);

      if (item.isDirectory()) {
        // The DECLARED exclusion set, applied at the directory edge and recorded. A subtree that is not excluded is
        // still walked in full, so a cache this program has never heard of is caught rather than ignored.
        if (INSTALLED_TREE_EXCLUSION_RE.test(pathRelative(root, absolute))) {
          excluded.add(pathRelative(root, absolute));
          // A3: the entries the exclusion REMOVES are counted, so "every byte under those paths is UNATTESTED" is a
          // magnitude and not a shrug. The count is a COUNT-ONLY walk: no name is hashed and no file is opened, so
          // quantifying the cost of the exclusion does not turn the exclusion into a content observation.
          const counted = countTreeEntries(absolute);

          // The excluded DIRECTORY is itself an unattested entry, not just what is under it.
          excludedEntries += counted.entries + 1;
          excludedEntriesBounded = excludedEntriesBounded || counted.bounded;
          continue;
        }

        walk(absolute);
        continue;
      }

      if (item.isSymbolicLink()) {
        let target = null;

        try {
          target = readlinkSync(absolute);
        } catch {
          target = null;
        }

        if (target === null) {
          entries = -1;
          return;
        }

        lines.push(`L|${pathRelative(root, absolute)}|${target}`);
        continue;
      }

      if (!item.isFile()) {
        continue;
      }

      let stat = null;

      try {
        stat = lstatSync(absolute);
      } catch {
        entries = -1;
        return;
      }

      if (tier === 'content') {
        const content = hashFileBytes16(absolute);

        if (content === null) {
          entries = -1;
          return;
        }

        lines.push(`F|${pathRelative(root, absolute)}|${content}`);
        continue;
      }

      // `ctimeMs` is in the metadata tier on purpose: the kernel updates it on every write and userspace cannot set it,
      // so "same size, same mtime" is not a way to hide a content change from this tier.
      lines.push(`F|${pathRelative(root, absolute)}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.mode & 0o777}`);
    }
  };

  walk(root);

  if (entries === -1 || lines.length === 0) {
    return null;
  }

  lines.sort();

  return {
    digest: digest16(lines.join('\n')),
    tier,
    entries: lines.length,
    // A3: the PRE-EXCLUSION count, beside the post-exclusion one, so the unattested population has a size. The
    // reconciliation is exact: `entries_raw - entries === excluded_entries`, and a bounded count is recorded as
    // bounded rather than as a complete one.
    entries_raw: lines.length + excludedEntries,
    excluded_entries: excludedEntries,
    excluded_entries_bounded: excludedEntriesBounded,
    // Part of the digest's DEFINITION, not of its implementation: a reader cannot interpret this digest without
    // knowing which bytes it did not cover, so the set and its cost travel with the value into the record and the docs.
    exclusions: [...INSTALLED_TREE_EXCLUSIONS.paths],
    exclusions_version: INSTALLED_TREE_EXCLUSIONS.version,
    excluded_paths: [...excluded].sort(),
    // `limitation` stays EXACTLY the tier's own label, because that string is a constant other readers and assertions
    // compare against. The exclusion travels beside it in `limitation_with_exclusions`, and THAT is what the
    // attestation and the environment record store as `installed_tree_fingerprint_limitation`: a digest whose
    // definition omits bytes is unreadable without the set, so the recorded label must carry both halves.
    limitation: TREE_FINGERPRINT_LIMITS[tier],
    limitation_with_exclusions: `${TREE_FINGERPRINT_LIMITS[tier]}. ${INSTALLED_TREE_EXCLUSIONS_TEXT}`,
  };
}

/** The reuse decision is correct under BOTH tiers, and states which one it used. */
function treeFingerprintTierOrFail(raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }

  if (!TREE_FINGERPRINT_TIERS.includes(raw)) {
    // The SAME sentence `census` and `regress` print, behind this command's own `UNKNOWN_FINGERPRINT_TIER:` prefix.
    workspaceFail(WORKSPACE_EXIT_USAGE, `UNKNOWN_FINGERPRINT_TIER: ${unknownFingerprintTierRefusal(raw).reason}`);
  }

  return raw;
}

/**
 * One standard, applied uniformly. `installed_historical` is only claimed when a real, contained `node_modules`
 * exists AND npm left its own record of installing it — a succeeded install with no `.package-lock.json` is a partial
 * install, and calling it installed would be the declaration-as-observation error this record exists to prevent.
 */
function classifyProvisioning(installed, installOutcome) {
  if (installed.topology === 'symlink') {
    return { value: 'linked_from_primary', basis: 'observed' };
  }

  if (installed.topology === 'missing') {
    return installed.scope === 'inherited_upward'
      ? { value: 'inherited_upward', basis: 'observed' }
      : { value: 'absent', basis: 'observed' };
  }

  if (installed.scope === 'inherited_upward' && installed.state_digest === null) {
    return { value: 'inherited_upward', basis: 'observed' };
  }

  if (installed.scope === 'escapes_worktree') {
    return { value: 'escapes_workspace', basis: 'observed' };
  }

  if (installed.scope !== 'worktree_local') {
    return { value: 'unresolved', basis: 'unresolved' };
  }

  return installOutcome === 'succeeded' && installed.state_digest !== null
    ? { value: 'installed_historical', basis: 'observed' }
    : { value: 'present_unattested', basis: 'observed' };
}

const RESOLVER_PROBE_SCRIPT = [
  "const names = JSON.parse(process.env.HARNESS_PROBE_NAMES ?? '[]');",
  'const out = names.map((name) => {',
  '  for (const spec of [name + "/package.json", name]) {',
  '    try { return { name, resolved: require.resolve(spec, { paths: [process.cwd()] }) }; } catch (error) { /* next */ }',
  '  }',
  '  return { name, resolved: null };',
  '});',
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

/**
 * F4 — the NEGATIVE CONTROL. `resolver_probe` only asks about names taken from the JUDGED COMMIT's own manifest, so it is
 * silent by construction about a package the commit never declared. An accepted `NODE_PATH` can supply exactly such a
 * package: `require('anything-in-NODE_PATH')` succeeds while every declared name still resolves inside the worktree, so
 * the whole probe set looks clean and the deviation line understates the reach of what was accepted.
 *
 * The control is a name that is not a declared dependency of anything and is not resolvable on a healthy machine. It is
 * probed with the SAME child process and the SAME resolver as the real names, and it is kept OUT of `resolver_probe`
 * itself: a control that correctly resolves to nothing must not be counted as "a dependency that failed to resolve",
 * which would conflate "nothing there" with "an escape" (F3) and would change the meaning of an existing field.
 */
const RESOLVER_NEGATIVE_CONTROL = 'harness-negative-control-4f1d9a-not-a-declared-dependency';

/** A fixed, capped set derived from the JUDGED COMMIT's own manifest. Never from the primary checkout. */
function judgeCommitProbeNames(workspacePath, cap = RESOLVER_PROBE_CAP) {
  let pkg = null;

  try {
    pkg = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf8'));
  } catch {
    return [];
  }

  const names = new Set();

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg?.[field] ?? {})) {
      names.add(name);
    }
  }

  return [...names].sort().slice(0, cap);
}

/**
 * The only field that catches upward inheritance, `NODE_PATH` poisoning, a missed symlink and a partially-installed
 * tree: the ABSOLUTE path Node actually resolves each probed name to, inside the judged workspace. One child process
 * resolves the whole capped set, so the cost is one spawn per invocation rather than five.
 */
function observeResolverProbe(workspacePath, childEnv, cap = RESOLVER_PROBE_CAP) {
  const names = judgeCommitProbeNames(workspacePath, cap);

  if (names.length === 0) {
    return [];
  }

  const unresolved = () => names.map((name) => ({ name, resolved: null }));
  const result = spawnSync(process.execPath, ['-e', RESOLVER_PROBE_SCRIPT], {
    cwd: workspacePath,
    encoding: 'utf8',
    env: { ...childEnv, HARNESS_PROBE_NAMES: JSON.stringify(names) },
  });

  if (result.status !== 0) {
    return unresolved();
  }

  try {
    const parsed = JSON.parse(result.stdout);

    return Array.isArray(parsed)
      ? parsed.map((entry) => ({
          name: String(entry?.name ?? ''),
          resolved: optionalTextOrNull(entry?.resolved, 1024),
        }))
      : unresolved();
  } catch {
    return unresolved();
  }
}

function probeResolvesInsideWorkspace(probe, workspacePath) {
  const root = safeRealpath(workspacePath);

  if (root === null) {
    return false;
  }

  return probe.length === 0 || probe.every((entry) => entry.resolved !== null && isContainedBy(entry.resolved, root));
}

/**
 * F4. The control is probed through the same child process and the same `require.resolve` call as a real name, so a
 * `NODE_PATH` that supplies an undeclared package makes it RESOLVE and the deviation becomes an observation.
 * A control that cannot be observed at all (the probe did not run) is `null`, never `false`.
 */
function observeResolverNegativeControl(workspacePath, childEnv) {
  const result = spawnSync(process.execPath, ['-e', RESOLVER_PROBE_SCRIPT], {
    cwd: workspacePath,
    encoding: 'utf8',
    env: { ...childEnv, HARNESS_PROBE_NAMES: JSON.stringify([RESOLVER_NEGATIVE_CONTROL]) },
  });

  if (result.status !== 0) {
    return { name: RESOLVER_NEGATIVE_CONTROL, resolved: null, observed: false, basis: 'unobserved' };
  }

  try {
    const parsed = JSON.parse(result.stdout);

    if (!Array.isArray(parsed) || parsed.length !== 1) {
      return { name: RESOLVER_NEGATIVE_CONTROL, resolved: null, observed: false, basis: 'unobserved' };
    }

    return {
      name: RESOLVER_NEGATIVE_CONTROL,
      resolved: optionalTextOrNull(parsed[0]?.resolved, 1024),
      observed: true,
      basis: 'observed: resolved with the same require.resolve the real probe uses, under the same child environment',
    };
  } catch {
    return { name: RESOLVER_NEGATIVE_CONTROL, resolved: null, observed: false, basis: 'unobserved' };
  }
}

/**
 * F3 — "resolved OUTSIDE the workspace" and "resolved to NOTHING" are different facts with different causes, and
 * conflating them writes a false reason into a durable record. An escape means something supplied a name that is not
 * this workspace's; a null means nothing at all supplied it. Both fail, on their own terms and with their own words.
 */
function classifyResolverProbe(probe, workspacePath) {
  const root = safeRealpath(workspacePath);
  const outside = [];
  const unresolved = [];

  for (const entry of probe) {
    if (entry.resolved === null) {
      unresolved.push(entry.name);
      continue;
    }

    if (root === null || !isContainedBy(entry.resolved, root)) {
      outside.push(entry.name);
    }
  }

  return {
    // The pre-existing boolean stays exactly what it was: `true` only when nothing escaped AND nothing failed to
    // resolve, so its meaning is unchanged for every existing reader, every existing case and every existing assertion.
    all_inside_workspace: probe.length === 0 || (outside.length === 0 && unresolved.length === 0),
    resolved_outside: outside,
    resolved_nothing: unresolved,
    probed: probe.length,
  };
}

/** The distinct, separately-worded durable reasons. A null resolution is never described as an escape. */
function resolverProbeProblems(classification) {
  const problems = [];

  if (classification.resolved_outside.length > 0) {
    problems.push(
      `the resolver probe resolved ${classification.resolved_outside.length} name(s) OUTSIDE the worktree root (upward inheritance or another source): ${classification.resolved_outside.join(', ')}`,
    );
  }

  if (classification.resolved_nothing.length > 0) {
    problems.push(
      `the resolver probe resolved NOTHING for ${classification.resolved_nothing.length} name(s) the judged commit declares as dependencies: ${classification.resolved_nothing.join(', ')} — these are absent, which is not the same fact as resolving outside the workspace`,
    );
  }

  return problems;
}

/**
 * A6 — the npm config FILES, recorded rather than trusted.
 *
 * `effectiveNpmrcDigest` already folded the user file into the reuse KEY, which is why a hostile `$HOME/.npmrc` could
 * not be silently reused across — but the KEY is one digest, it names no path, and it appears in no environment
 * record. So a run under `gate_env_policy: "sanitised"`, `deviation: null` said nothing at all about the channel that
 * was still open. This is the observability half: every environment record now carries the resolved user/global
 * config paths with their digests and an honest basis, and `prepare` records the registry npm actually resolved.
 *
 * It is deliberately NOT a refusal. A config file is a channel the environment sanitisation does not close, and
 * pretending otherwise would be the same class of overstatement this record exists to avoid. See `NPM_CONFIG_FILES_BASIS`.
 */
function observeNpmConfigFiles(env = process.env) {
  // `NPM_CONFIG_USERCONFIG` is dropped by the sanitised construction, so npm re-derives `$HOME/.npmrc` from `HOME`,
  // which passes through untouched. Both the override and the derived default are named so a reader can see which
  // one npm would have read.
  const override =
    typeof env.NPM_CONFIG_USERCONFIG === 'string' && env.NPM_CONFIG_USERCONFIG !== ''
      ? env.NPM_CONFIG_USERCONFIG
      : null;
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir();
  const userPath = override ?? join(home, '.npmrc');
  const userPresent = existsSync(userPath);
  const globalPath = NPM_GLOBAL_CONFIG_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
  // npm is asked for the registry ONLY when a config file is actually in play. With no file at all, `npm config get
  // registry` can only echo a built-in default, and spawning npm on every `evaluate` to learn a constant is a tax with
  // no observation in it. `registry: null` then means "not queried because no config file existed" — never "the default".
  const registryQueried = userPresent || globalPath !== null;
  const registry = registryQueried
    ? optionalTextOrNull((run('npm', ['config', 'get', 'registry'], { silent: true, env }) ?? {}).stdout?.trim(), 300)
    : null;

  return {
    user_config_path: userPath,
    user_config_source: override === null ? 'derived_from_HOME' : 'NPM_CONFIG_USERCONFIG',
    user_config_digest: digestFile16(userPath),
    user_config_present: userPresent,
    global_config_path: globalPath,
    global_config_digest: globalPath === null ? null : digestFile16(globalPath),
    registry,
    registry_queried: registryQueried,
    registry_basis: registryQueried
      ? 'read from npm itself, with the same child environment the install and the gate received'
      : 'not queried: no npm config file was present, so the registry cannot have been redirected by one',
    basis: NPM_CONFIG_FILES_BASIS,
  };
}

function effectiveNpmrcDigest(projectNpmrcBytes) {
  return digest16(
    canonicalJson({
      // The commit's own `.npmrc` (DECLARED, and it is what the install inside the worktree would read), the operator's
      // user-level file, and a constant standing in for npm's built-in defaults.
      project: projectNpmrcBytes === null ? null : digest16(projectNpmrcBytes),
      user: digestFile16(join(homedir(), '.npmrc')),
      builtin: digest16('npm-builtin-defaults'),
    }),
  );
}

/**
 * §2.4 plus C5. The key answers "is this the same environment, verified the same way", so every input that changes the
 * tree moves it: the commit, the lockfile BYTES, the FULL node version (which subsumes minor and patch), the FULL
 * package-manager version (a tree installed under npm 12 is not the tree npm 9 would have produced, so a major-only key
 * would alias two different trees), the platform, the effective `.npmrc`, the `npm_config_*` subset, AND THE FINGERPRINT
 * TIER the reuse check will be performed at. The tier is in the key because a workspace verified by walking CONTENT and
 * one verified by walking METADATA are verified under DIFFERENT RULES: without it, changing `--fingerprint` would
 * silently reuse a workspace attested under the other tier, which is the declared-vs-observed error again in a new place.
 * The requested ref is NOT in the key: a tag, a branch and a sha naming one object share one worktree.
 *
 * Consequence, stated rather than discovered: changing the tier moves every key, so a workspace prepared under a
 * previous build is never silently reused under this one. It is reclaimed and rebuilt, which is the correct cost.
 */
function computeWorkspaceKey({
  commit,
  lockfileDigest,
  nodeVersion,
  packageManager,
  platform,
  npmrcDigest,
  npmConfigDigest,
  fingerprintTier,
  exclusionsVersion = null,
  build = null,
}) {
  return digest16(
    canonicalJson({
      judged_commit: commit,
      lockfile_digest: lockfileDigest,
      node_version: nodeVersion,
      package_manager_name: packageManager?.name ?? null,
      package_manager_version: packageManager?.version ?? null,
      platform_os: platform.os,
      platform_arch: platform.arch,
      npmrc_digest: npmrcDigest,
      npm_config_digest: npmConfigDigest,
      installed_tree_fingerprint_tier: fingerprintTier ?? null,
      // The EXCLUSION SET, on exactly the tier's own rationale: widening `.vite`/`.cache` — or replacing them —
      // changes what the digest MEANS while leaving its algorithm, its tier and its cost identical. A workspace
      // verified under one exclusion set is verified under different RULES from one verified under another, so reuse
      // must not cross that boundary silently. Previously the version was RECORDED in the attestation and nowhere in
      // the key, which is the same "recorded but not enforced" gap `installed_tree_fingerprint_tier` did not have.
      installed_tree_fingerprint_exclusions_version: exclusionsVersion ?? null,
      // The BUILD, for the same reason the tier is here: a workspace verified with a build and one verified without are
      // verified under DIFFERENT RULES, and a workspace built under one plan is not interchangeable with one built
      // under another. `build` carries the MODE (`derived` / `declared` / `disabled`) and the plan digest; the build's
      // OUTCOME and the build-state bytes are re-observed on every reuse, exactly as the tree fingerprint is.
      historical_build_mode: build?.mode ?? null,
      historical_build_plan_digest: build?.plan_digest ?? null,
      historical_build_command: build?.command ?? null,
    }),
  );
}

function gitShowBytes(commit, path) {
  const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: REPO_ROOT, encoding: 'buffer' });

  return result.status === 0 && result.stdout !== null && result.stdout.length > 0 ? Buffer.from(result.stdout) : null;
}

function readHistoricalManifest(commit, path) {
  const raw = git(['show', `${commit}:${path}`], REPO_ROOT);

  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The lockfile versions a given npm is known to accept. npm >= 7 accepts v1 and v2 SILENTLY, so "the install exited 0"
 * is not evidence that the lockfile was read the way the commit's author expected: a success-shaped wrong answer. The
 * version is therefore checked BEFORE any install is spent, and a presence check alone is explicitly not sufficient —
 * a stale lockfile satisfies it.
 */
function npmSupportedLockfileVersions(npmVersion) {
  const major = Number(/^(\d+)\./.exec(npmVersion ?? '')?.[1] ?? '0');

  return Number.isInteger(major) && major >= 7 ? [1, 2, 3] : [1, 2];
}

function assertHistoricalProject({ commit, lockfileRaw, packageManager, acceptLockfileVersion, acceptPmMismatch }) {
  if (lockfileRaw === null) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `NO_LOCKFILE: ${commit} has no ${EVALUATIONS_LOCKFILE} — there is nothing to install deterministically. Presence is necessary, not sufficient: a stale lockfile satisfies it too, which is why the digest is in the reuse key.`,
    );
  }

  let parsed = null;

  try {
    parsed = JSON.parse(lockfileRaw.toString('utf8'));
  } catch {
    parsed = null;
  }

  const version = Number.isInteger(parsed?.lockfileVersion) ? parsed.lockfileVersion : null;
  const supported = npmSupportedLockfileVersions(packageManager?.version ?? null);
  const supportedVersion = version !== null && supported.includes(version);

  if (!supportedVersion && !acceptLockfileVersion) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `LOCKFILE_VERSION_UNSUPPORTED: ${EVALUATIONS_LOCKFILE} declares lockfileVersion ${version ?? '(unreadable)'} and npm ${packageManager?.version ?? '?'} is known to accept ${supported.join(', ')}. npm >= 7 accepts v1 and v2 SILENTLY, so an out-of-set version is a success-shaped wrong answer. Re-run with --accept-lockfile-version to record the acceptance.`,
    );
  }

  if (packageManager?.declared_field_conflict === true && !acceptPmMismatch) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `PACKAGE_MANAGER_CONFLICT: the commit declares packageManager "${packageManager.declared_field}" but ${packageManager.name} ${packageManager.version} is what the path probe resolved. Re-run with --accept-pm-mismatch to record the deviation.`,
    );
  }

  return { lockfile_version: version, lockfile_version_supported: supportedVersion };
}

function defaultEnvironmentInput() {
  return {
    extra: {
      // C7: this repository's root package.json runs `prepare: husky`, which writes `core.hooksPath` into the PRIMARY
      // repository's shared `.git/config`. The install runs with HUSKY=0 and the fact is recorded as a deviation.
      HUSKY: '0',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  };
}

function buildEnvironmentEntry({
  at,
  runId,
  task,
  gateBearing,
  workspacePath,
  childEnv,
  envMeta,
  install,
  packageManager,
  platform,
  workspaceKey,
  workspaceInstanceLabel,
  workspaceRootSource,
  workspaceRootPath,
  resolverProbe,
  resolverProbeRan,
  historicalScripts,
  gitConfig,
  judgedCommit,
  deviation,
  gateEnvPolicy,
  treeFingerprint,
  probeClassification,
  negativeControl,
  npmConfigFiles = null,
  build = null,
  buildState = null,
  buildStateBasis = null,
  buildPlan = null,
}) {
  const installed = observeInstalledState(workspacePath);
  const provisioning = classifyProvisioning(installed, install?.outcome ?? 'not_run');
  const node = observeNode(readHistoricalManifest(judgedCommit ?? task?.source_commit, 'package.json') ?? null);

  return {
    at,
    run_id: runId,
    schema_version: ENVIRONMENTS_SCHEMA_VERSION,
    gate_bearing: gateBearing === true,
    declared_source_commit: hexOrNull(task?.source_commit, LEDGER_GIT_HEX_RE),
    judged_commit: hexOrNull(judgedCommit, JUDGED_COMMIT_RE),
    judged_commit_basis: 'observed',
    workspace_key: hexOrNull(workspaceKey, DIGEST_16_RE),
    workspace_instance: optionalTextOrNull(workspaceInstanceLabel, 40),
    workspace_root_source: WORKSPACE_ROOT_SOURCES.includes(workspaceRootSource) ? workspaceRootSource : null,
    workspace_root_digest:
      workspaceRootPath === null || workspaceRootPath === undefined ? null : digest16(workspaceRootPath),
    dependency_provisioning: provisioning.value,
    dependency_provisioning_basis: provisioning.basis,
    node_modules_topology: installed.topology,
    node_modules_scope: installed.scope,
    node_modules_realpath: optionalTextOrNull(installed.realpath, 1024),
    installed_package_count: Number.isInteger(installed.entry_count) ? installed.entry_count : null,
    installed_entry_count_raw: Number.isInteger(installed.entry_count_raw) ? installed.entry_count_raw : null,
    installed_entry_count_excluded: installed.entry_count_excluded ?? null,
    installed_state_digest: installed.state_digest,
    // D11: this is what npm SAYS it installed. Not an independent observation of the bytes.
    installed_state_digest_source: installed.state_digest_source,
    // The observation THIS program makes, under its own name and its own label. `null` when the run did not ask for
    // one: an `evaluate` on the 912 MB primary checkout does not walk 54 744 files to answer a question the workspace
    // attestation already answers, and "not computed" is recorded as "not computed", never as "unchanged".
    installed_tree_fingerprint: treeFingerprint?.digest ?? null,
    installed_tree_fingerprint_tier: treeFingerprint?.tier ?? null,
    // A3: the pre-exclusion count beside the post-exclusion one, so the unattested population has a size and the two
    // reconcile (entries_raw - entries === excluded_entries). Additive and normalised to null: a record written before
    // this field existed reads as "not recorded".
    installed_tree_fingerprint_entries: treeFingerprint?.entries ?? null,
    installed_tree_fingerprint_entries_raw: treeFingerprint?.entries_raw ?? null,
    installed_tree_fingerprint_excluded_entries: treeFingerprint?.excluded_entries ?? null,
    installed_tree_fingerprint_excluded_entries_bounded: treeFingerprint?.excluded_entries_bounded ?? null,
    installed_tree_fingerprint_limitation: treeFingerprint?.limitation_with_exclusions ?? null,
    installed_tree_fingerprint_basis: TREE_FINGERPRINT_STANDING_LIMIT,
    // The EXCLUSION set travels with the digest it qualifies: a digest whose definition omits bytes is unreadable
    // without it, and a silent exclusion would be a content-pin claim this program cannot support.
    installed_tree_fingerprint_exclusions: treeFingerprint?.exclusions ?? [...INSTALLED_TREE_EXCLUSIONS.paths],
    installed_tree_fingerprint_exclusions_version: INSTALLED_TREE_EXCLUSIONS.version,
    // P0: the BUILD, in the environment record too. The install-failure case is served by the `environment_observed`
    // run event and the workspace attestation, never by the ledger, so the shape here is the same additive one.
    historical_build_mode: build?.mode ?? null,
    historical_build_command: build?.command ?? null,
    historical_build_command_basis: build?.command_basis ?? null,
    historical_build_outcome: build?.outcome ?? null,
    historical_build_exit_code: build?.exit_code ?? null,
    historical_build_duration_ms: build?.duration_ms ?? null,
    historical_build_plan_digest: buildPlan === null ? null : (build?.plan_digest ?? null),
    historical_build_plan_packages: buildPlan === null ? null : (buildPlan.packages ?? []).map((entry) => entry.name),
    // Never `true`, and never omitted: an omitted field is a question a reader has to answer by guessing.
    historical_build_executed_arbitrary_scripts: build === null ? null : (build.script_execution ?? null),
    historical_build_script_execution_basis:
      build === null
        ? 'not applicable: this command performed no historical build, so no build string could have been executed by it'
        : build.script_execution_basis,
    // A8: what the build did OUTSIDE the worktree, plus — as data — the class the record does NOT observe. Additive
    // and null-normalised; `evaluate` runs no build of its own, so it says so rather than reporting an empty sweep.
    historical_build_outside_worktree_writes: build?.outside_worktree_writes ?? null,
    historical_build_outside_worktree_writes_basis:
      build === null || build.outside_worktree_writes === undefined
        ? 'not applicable to THIS run: this command performed no historical build, so there was nothing whose outside-worktree writes could be observed. If `workspace prepare` built the workspace, THAT step recorded the observation in the workspace attestation'
        : build.outside_worktree_writes.basis,
    build_state: buildState,
    // A7: this sentence is a CLAIM about the gate, so it is only ever printed when the plan actually supports it. A
    // null build state while the plan DID declare a package to build is a different fact, and is named as such.
    build_state_basis:
      buildStateBasis ??
      (buildState === null
        ? buildPlan !== null && (buildPlan.packages ?? []).length > 0
          ? 'not observed: the plan derived from this commit declares build output the gate resolves through, and no build state was observed for it. This is NOT a claim that the gate needs no build output'
          : 'not applicable: no build output is required by the gate this run resolved, so there is no build state to observe'
        : null),
    build_state_limitation: buildState?.limitation ?? null,
    resolver_probe: resolverProbeRan === true ? resolverProbe : null,
    resolver_probe_all_inside_workspace: probeClassification?.all_inside_workspace ?? null,
    // F3: the two reasons are recorded as two fields, so a reader never has to infer which one applied.
    resolver_probe_resolved_outside: probeClassification?.resolved_outside ?? null,
    resolver_probe_resolved_nothing: probeClassification?.resolved_nothing ?? null,
    resolver_probe_negative_control: negativeControl ?? null,
    install,
    package_manager: packageManager,
    node,
    platform,
    env: envFacts(childEnv, envMeta),
    // A6: the npm config FILES, which the sanitised environment does NOT close. Additive and optional — a record
    // written before this field existed reads as "not recorded", never as an error. `fields()` in
    // `validateOperationalLedger` REQUIRES every key it names, so this one is deliberately not in that shape: adding it
    // there would reclassify every existing environment record as `rejected` on the next read and remove its ledger
    // permanently from `newestLedgerForTask`, `ledger show` and `report`.
    npm_config_files: npmConfigFiles,
    // P1 newly executes code from a historical manifest. What the record says is what was OBSERVED, and what was
    // observed about script execution is nothing: npm does not report it, so the value is `null` and never `true`.
    historical_install_executed_arbitrary_scripts: historicalScripts,
    // `evaluate` runs no install, so the POLICY fields say exactly that rather than being omitted: "not applicable" is
    // a fact, and an omitted field is a question a reader has to answer by guessing.
    historical_install_script_execution_basis:
      'not applicable: this command performed no install, so no lifecycle script could have been executed by it',
    historical_install_scripts_policy: 'not_applicable',
    historical_install_ignore_scripts: null,
    historical_install_output_showed_script_output: null,
    historical_install_output_basis: 'not applicable: this command produced no install output',
    gate_env_policy: GATE_ENV_POLICIES.includes(gateEnvPolicy) ? gateEnvPolicy : null,
    primary_git_config_hooks_path_before: optionalTextOrNull(gitConfig?.before?.core_hooks_path, 200),
    primary_git_config_hooks_path_after: optionalTextOrNull(gitConfig?.after?.core_hooks_path, 200),
    primary_git_config_changed: detectPrimaryCheckoutChange(gitConfig?.before, gitConfig?.after),
    deviation: optionalTextOrNull(deviation, 400),
    bounded_reason: null,
  };
}

/** The flat subset that rides along in `run_started.environment` as additive sibling keys. */
function environmentSummary(entry) {
  return {
    dependency_provisioning: entry.dependency_provisioning,
    dependency_provisioning_basis: entry.dependency_provisioning_basis,
    node_modules_topology: entry.node_modules_topology,
    node_modules_scope: entry.node_modules_scope,
    installed_package_count: entry.installed_package_count,
    installed_state_digest: entry.installed_state_digest,
    installed_state_digest_source: entry.installed_state_digest_source,
    // npm's account of the tree, and ONLY that. It is not a verification of the bytes and is never presented as one.
    installed_state_digest_basis: 'declared_by_npm',
    installed_tree_fingerprint: entry.installed_tree_fingerprint,
    installed_tree_fingerprint_tier: entry.installed_tree_fingerprint_tier,
    installed_tree_fingerprint_basis: 'observed_by_this_program_walking_the_tree_at_the_named_tier',
    // The exclusion set and the build state ride into the run STREAM as well, so a reader of the stream — not only of a
    // ledger or an attestation — can see which bytes the digest did not cover and what the source-tree build state was.
    installed_tree_fingerprint_exclusions: entry.installed_tree_fingerprint_exclusions,
    // A3 / A8: the unattested population's size, and the build's outside-worktree observation, both in the run STREAM
    // and not only in a ledger, so a reader of the stream sees the same limits.
    installed_tree_fingerprint_entries: entry.installed_tree_fingerprint_entries ?? null,
    installed_tree_fingerprint_entries_raw: entry.installed_tree_fingerprint_entries_raw ?? null,
    installed_tree_fingerprint_excluded_entries: entry.installed_tree_fingerprint_excluded_entries ?? null,
    historical_build_outside_worktree_writes_detected:
      entry.historical_build_outside_worktree_writes?.outside_worktree_write_detected ?? null,
    build_state_digest: entry.build_state?.digest ?? null,
    build_state_observed: entry.build_state === null ? null : entry.build_state.observed === true,
    historical_build_mode: entry.historical_build_mode,
    historical_build_command: entry.historical_build_command,
    historical_build_outcome: entry.historical_build_outcome,
    historical_build_executed_arbitrary_scripts: entry.historical_build_executed_arbitrary_scripts,
    resolver_probe: entry.resolver_probe,
    resolver_probe_resolved_outside: entry.resolver_probe_resolved_outside,
    resolver_probe_resolved_nothing: entry.resolver_probe_resolved_nothing,
    resolver_probe_negative_control_resolved: entry.resolver_probe_negative_control?.resolved ?? null,
    gate_env_policy: entry.gate_env_policy,
    historical_install_executed_arbitrary_scripts: entry.historical_install_executed_arbitrary_scripts,
    install_outcome: entry.install?.outcome ?? 'not_run',
    package_manager_name: entry.package_manager?.name ?? null,
    package_manager_version: entry.package_manager?.version ?? null,
    package_manager_declared_field: entry.package_manager?.declared_field ?? null,
    node_version: entry.node?.version ?? null,
    node_major: entry.node?.major ?? null,
    platform_os: entry.platform?.os ?? null,
    platform_arch: entry.platform?.arch ?? null,
    env_vars_digest: entry.env?.vars_digest ?? null,
    env_var_count: entry.env?.count ?? null,
    // A6: the digests ride into the run_started summary too, so a reader of the run STREAM — not only of a ledger —
    // can see which npm config files were in reach. All `null` on a record written before this field existed.
    npmrc_user_config_digest: entry.npm_config_files?.user_config_digest ?? null,
    npmrc_user_config_path: entry.npm_config_files?.user_config_path ?? null,
    npmrc_global_config_digest: entry.npm_config_files?.global_config_digest ?? null,
    npmrc_registry: entry.npm_config_files?.registry ?? null,
    npmrc_channel_basis: entry.npm_config_files?.basis ?? null,
    env_basis: 'observed: the effective child environment this harness constructed (values are never recorded)',
    workspace_key: entry.workspace_key,
    workspace_instance: entry.workspace_instance,
    env_standing_limitation:
      'a worktree is not a security boundary and historical reproducibility is not result authenticity; "observed" means this local program looked',
  };
}

/**
 * C4: bounded by SERIALISED BYTES against `LEDGER_MAX_BYTES`, not by a count. A 10 000-entry array of 1-2 KB entries is
 * 10-20 MB, and a ledger over the limit is `rejected` on the next read and therefore permanently invisible to
 * `newestLedgerForTask`, `ledger show` and `report`. The post-mutation size is computed on the WRITER side and the
 * oldest entries are evicted with a recorded reason; a single entry that does not fit is refused rather than written.
 */
function appendEnvironment(ledger, entry, options = {}) {
  const maxBytes = options.maxBytes ?? LEDGER_MAX_BYTES;
  const existing = ledger.environments ?? [];

  if (existing.length >= ENVIRONMENTS_MAX_ENTRIES) {
    throw new Error(
      `ENVIRONMENTS_CAPACITY_EXCEEDED: environments[] already holds ${existing.length} entries (max ${ENVIRONMENTS_MAX_ENTRIES})`,
    );
  }

  const bytesOf = (value) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let next = [...existing, entry];
  let evicted = 0;

  while (next.length > 1 && bytesOf({ ...ledger, environments: next }) > maxBytes) {
    next = next.slice(1);
    evicted += 1;
  }

  if (bytesOf({ ...ledger, environments: next }) > maxBytes) {
    throw new Error(
      `ENVIRONMENTS_BYTE_BUDGET_EXCEEDED: one environment record of ${bytesOf({ ...ledger, environments: next })} bytes does not fit the ${maxBytes}-byte ledger budget`,
    );
  }

  next[next.length - 1] = {
    ...next[next.length - 1],
    bounded_reason:
      evicted === 0
        ? null
        : `evicted ${evicted} oldest environment record(s) to stay inside the ${maxBytes}-byte ledger budget`,
  };
  ledger.environments = next;

  return { evicted, bytes: bytesOf({ ...ledger, environments: next }) };
}

function observePrimaryGitConfig() {
  const path = join(REPO_ROOT, '.git', 'config');
  let raw = null;

  try {
    raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    raw = null;
  }

  const match = raw === null ? null : /^[ \t]*hooksPath[ \t]*=[ \t]*(.+)$/m.exec(raw);

  return { digest: raw === null ? null : digest16(raw), core_hooks_path: match === null ? null : match[1].trim() };
}

function detectPrimaryCheckoutChange(before, after) {
  return (before?.digest ?? null) !== (after?.digest ?? null);
}

function observePrimaryNodeModules() {
  const installed = observeInstalledState(REPO_ROOT);

  return {
    digest: installed.state_digest,
    entry_count: installed.entry_count,
    topology: installed.topology,
  };
}

// ---------------------------------------------------------------- historical workspace lifecycle (P1)

function workspaceInstance(flags) {
  const raw = flags.instance;

  if (raw === undefined) {
    return WORKSPACE_DEFAULT_INSTANCE;
  }

  if (typeof raw !== 'string' || !WORKSPACE_INSTANCE_RE.test(raw)) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `--instance must match ${WORKSPACE_INSTANCE_RE} — an instance label gives each side of a future comparison its OWN directory, so two sides at the same commit cannot collide (default: ${WORKSPACE_DEFAULT_INSTANCE})`,
    );
  }

  return raw;
}

function acceptedInheritedEnvNames(flags) {
  const raw = flags['accept-inherited-env'];

  if (raw === undefined) {
    return [];
  }

  if (typeof raw !== 'string') {
    workspaceFail(WORKSPACE_EXIT_USAGE, '--accept-inherited-env must be a comma-separated list of variable names');
  }

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const unknown = names.filter((name) => !ENV_REFUSED_NAMES.includes(name));

  if (unknown.length > 0) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `--accept-inherited-env only accepts ${ENV_REFUSED_NAMES.join(', ')}; refused: ${unknown.join(', ')}`,
    );
  }

  return names;
}

function parseDurationMs(raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());

  if (match === null) {
    return null;
  }

  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 'ms'];
}

function workspaceInstanceDirectory(root, key, instance) {
  return join(root, key, instance);
}

function workspaceAttestationPath(key, instance) {
  return resolveControlPath(WORKSPACES_DIR, `${key}.${instance}.json`);
}

/** A5: the ONE definition of the attestation state enum, and the only thing allowed to decide what counts as one. */
function workspaceAttestationStateIsKnown(state) {
  return typeof state === 'string' && WORKSPACE_STATES.includes(state);
}

function readWorkspaceAttestation(key, instance) {
  const path = workspaceAttestationPath(key, instance);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = parseStrictJson(readFileSync(path));

    // A5: the runtime validates its OWN attestation state enum on read, instead of leaving a second copy of the enum in
    // the test file to be the only thing that ever checks it. An attestation in a state this program does not define is
    // not an attestation as far as reuse is concerned, and the refusal it causes is fail-closed: `null` means the
    // caller re-provisions rather than trusting a record whose own vocabulary it cannot parse.
    if (parsed.ok && !workspaceAttestationStateIsKnown(parsed.value?.state)) {
      return null;
    }

    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

function writeWorkspaceAttestation(attestation) {
  const key = attestation?.workspace_key;
  const instance = attestation?.workspace_instance;

  if (
    typeof key !== 'string' ||
    !DIGEST_16_RE.test(key) ||
    typeof instance !== 'string' ||
    !WORKSPACE_INSTANCE_RE.test(instance)
  ) {
    fail('a workspace attestation needs a 16-hex workspace_key and a bounded workspace_instance');
  }

  prepareControlRoot(WORKSPACES_DIR);

  const path = workspaceAttestationPath(key, instance);
  const temp = join(WORKSPACES_DIR, `.${key}.${instance}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`);
  const fd = openSync(temp, 'wx');

  try {
    writeAll(fd, bytes, DEFAULT_FS);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temp, path);

  return path;
}

function listWorkspaceAttestations() {
  if (!existsSync(WORKSPACES_DIR)) {
    return [];
  }

  return readdirSync(WORKSPACES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(WORKSPACES_DIR, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null && DIGEST_16_RE.test(entry.workspace_key ?? ''));
}

/**
 * C5, twice. The five reuse conditions in the design re-read NO bytes of the installed tree, so a truncated or
 * human-modified `node_modules` satisfied all five and produced the exact false-regression shape this increment
 * exists to remove.
 *
 * Re-verifying `installed_state_digest` on every reuse closed the TRUNCATION case and left the IN-PLACE EDIT case
 * open: `.package-lock.json` is npm's ACCOUNT of the tree, so editing one byte of one installed file — no add, no
 * remove, entry count unchanged, `.package-lock.json` untouched — satisfied every condition and produced a false
 * green for a commit whose real dependencies fail. Reuse therefore ALSO requires `installed_tree_fingerprint`, an
 * observation THIS program makes by walking the directory at the recorded tier, and it FAILS CLOSED: a tree that
 * cannot be walked at all is not reusable, with no fallback to a cheaper rule.
 *
 * The tier is in the reuse key, so a workspace attested under `metadata` is never reused under `content` and vice
 * versa. `installed_state_digest` is still compared, still named for what it is, and still labelled npm's
 * declaration: it is a cheap independent signal, never a substitute for the walk.
 */
function verifyReusableWorkspace({
  attestation,
  directory,
  commit,
  key,
  instance,
  fingerprintTier,
  build = null,
  childEnv = null,
}) {
  const refuse = (reason, detail = null) => ({ reusable: false, reason, detail });

  if (attestation === null) {
    return refuse('no_attestation');
  }

  if (attestation.schema_version !== WORKSPACE_ATTESTATION_SCHEMA_VERSION) {
    return refuse('attestation_schema_mismatch');
  }

  if (attestation.state !== 'usable') {
    return refuse(`attestation_state_${attestation.state ?? 'unknown'}`);
  }

  if (attestation.workspace_key !== key || attestation.workspace_instance !== instance) {
    return refuse('key_mismatch');
  }

  if (attestation.judged_commit !== commit) {
    return refuse('commit_mismatch');
  }

  if (!existsSync(directory)) {
    return refuse('directory_absent');
  }

  const head = normalizeCommitSha((git(['rev-parse', 'HEAD'], directory) ?? '').trim());

  if (head !== commit) {
    return refuse('head_mismatch');
  }

  const installed = observeInstalledState(directory);

  if (installed.topology !== 'real_directory') {
    return refuse(`node_modules_${installed.topology}`);
  }

  if (installed.scope !== 'worktree_local') {
    return refuse(`node_modules_scope_${installed.scope}`);
  }

  if (installed.state_digest === null) {
    return refuse('installed_state_digest_unavailable');
  }

  if (installed.state_digest !== attestation.installed_state_digest) {
    return refuse('installed_state_digest_changed');
  }

  if ((installed.entry_count ?? -1) !== (attestation.installed_package_count ?? -2)) {
    return refuse('installed_entry_count_changed');
  }

  // The attestation must have been written at the tier THIS run verifies at, and it must carry a fingerprint at all.
  // An attestation from a build that predates the walk has no fingerprint, and "no fingerprint" is NOT "no change".
  if (attestation.installed_tree_fingerprint_tier !== fingerprintTier) {
    return refuse('installed_tree_fingerprint_tier_mismatch', {
      attested: attestation.installed_tree_fingerprint_tier ?? null,
      requested: fingerprintTier,
    });
  }

  // A2: the exclusion set is enforced through the REUSE KEY, not through a second field comparison here.
  // `computeWorkspaceKey` digests `installed_tree_fingerprint_exclusions_version`, so a workspace verified under a
  // different exclusion set gets a different key and a different directory, and therefore has no attestation for this
  // walk to be compared against at all. A second check here would only add a refusal reason able to fire AHEAD of the
  // specific ones — the tier, the installed-state digest, the tree walk — and turn an honest "this is not the same
  // workspace" into a bare mismatch.

  if (
    typeof attestation.installed_tree_fingerprint !== 'string' ||
    !DIGEST_16_RE.test(attestation.installed_tree_fingerprint)
  ) {
    return refuse('installed_tree_fingerprint_unattested');
  }

  // FAIL CLOSED. No walk, no reuse: there is deliberately no silent downgrade to the cheaper walk, because a silent
  // downgrade is how a false green comes back wearing a new name.
  const fingerprint = observeInstalledTreeFingerprint(directory, fingerprintTier);

  if (fingerprint === null) {
    return refuse('installed_tree_fingerprint_unavailable', { tier: fingerprintTier });
  }

  if (fingerprint.digest !== attestation.installed_tree_fingerprint) {
    return refuse('installed_tree_fingerprint_changed', {
      tier: fingerprintTier,
      attested: attestation.installed_tree_fingerprint,
      observed: fingerprint.digest,
    });
  }

  // P0 — the BUILD STATE, third leg of the same argument. The two checks above re-read bytes under `node_modules`, and
  // the bytes that decide whether a historical gate can even RUN live in the SOURCE tree: `shared/dist` is gitignored,
  // so `status_hash` does not move when it is deleted, and a workspace whose `shared/dist` was removed was certified
  // "reused — re-verified ... all match" — a false green for a workspace that cannot pass its own gate.
  //
  // So a deleted or STALE build output now REBUILDS, and a build state that cannot be observed at all is REFUSED.
  // There is deliberately no fallback to the cheaper installed-tree evidence: a silent downgrade is how a false green
  // returns wearing a new name, and "the build is fine, probably" is not a decision this harness is allowed to make.
  const buildState = verifyReusableBuildState({ attestation, directory, build, childEnv });

  if (buildState.reusable !== true) {
    return refuse(buildState.reason, buildState.detail);
  }

  return { reusable: true, reason: 'verified', detail: null, installed, fingerprint, buildState: buildState.state };
}

/**
 * The build half of the reuse decision, kept apart from the installed-tree half so each refusal keeps its OWN name: a
 * build that cannot be observed and a build whose bytes changed are different facts with different consequences, and
 * conflating them would write a false reason into a durable record.
 */
function verifyReusableBuildState({ attestation, directory, build, childEnv }) {
  const refuse = (reason, detail = null) => ({ reusable: false, reason, detail });

  if (build === null) {
    // No build component was supplied, which means this call site is not asking about the build at all — an existing
    // direct caller of the installed-tree check. Refusing here would make that half unreachable, so the installed-tree
    // decision stands on its own; what is deliberately NOT done is upgrading that into a claim about the build, so the
    // returned state says the build was not verified. `workspace prepare` never takes this path: it always derives a
    // plan (or records a disabled/declared mode) before it computes a key.
    return {
      reusable: true,
      reason: 'build_component_not_supplied',
      state: null,
      verified: false,
      detail: {
        build_verified: false,
        basis: 'no build component was supplied to this verification, so nothing about the build state was checked',
      },
    };
  }

  if (attestation.historical_build_mode !== build.mode) {
    return refuse('historical_build_mode_mismatch', {
      attested: attestation.historical_build_mode ?? null,
      requested: build.mode,
    });
  }

  if ((attestation.historical_build_plan_digest ?? null) !== (build.plan_digest ?? null)) {
    return refuse('historical_build_plan_mismatch', {
      attested: attestation.historical_build_plan_digest ?? null,
      requested: build.plan_digest ?? null,
    });
  }

  // An EMPTY plan is a derivation result, not a failure to observe: there is nothing the gate resolves through a build
  // output, so there is no build state to re-verify. It is still compared, because the plan digest above already covers
  // "nothing to build" and a plan that became non-empty must never be handed back as empty.
  if (build.plan === null || build.plan.packages.length === 0) {
    if ((attestation.build_state?.digest ?? null) !== null) {
      return refuse('build_state_recorded_for_an_empty_plan', {
        attested: attestation.build_state?.digest ?? null,
      });
    }

    return { reusable: true, reason: 'verified', state: null, verified: true, detail: null };
  }

  const state = observeBuildState(directory, build.plan, childEnv);

  if (state.observed !== true) {
    return refuse('build_state_unobservable', {
      basis: state.basis,
      missing_outputs: state.missing_outputs,
      unwalkable_outputs: state.unwalkable_outputs,
    });
  }

  if (!DIGEST_16_RE.test(attestation.build_state?.digest ?? '')) {
    return refuse('build_state_unattested');
  }

  if (state.digest !== attestation.build_state.digest) {
    return refuse('build_state_changed', {
      attested: attestation.build_state.digest,
      observed: state.digest,
    });
  }

  return { reusable: true, reason: 'verified', state, verified: true, detail: null };
}

/** A bounded walk: the worktree, `.git` excluded, collecting every path NAMED `node_modules` at any depth. */
function workspaceNodeModulesPaths(directory, depth = 0) {
  if (depth > 6) {
    return [];
  }

  let entries = null;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];

  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }

    const absolute = join(directory, entry.name);

    if (entry.name === 'node_modules') {
      found.push(absolute);
      continue;
    }

    if (entry.isDirectory()) {
      found.push(...workspaceNodeModulesPaths(absolute, depth + 1));
    }
  }

  return found;
}

/**
 * C2, on the read side. `npm ci` DESTROYS the target of a symlinked `node_modules`
 * (`npm warn reify Removing non-directory <path>/node_modules`): the symlink is replaced by a real directory and the
 * target's entire contents are deleted. A symlink is therefore REPORTED, never passed to npm — the harness never
 * creates one, and it never lets one reach an install.
 */
function assertNoSymlinkedNodeModules(directory) {
  const symlinks = workspaceNodeModulesPaths(directory).filter((path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  });

  if (symlinks.length > 0) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `SYMLINKED_NODE_MODULES: ${symlinks.join(', ')} — "npm ci" destroys the target of a symlinked node_modules (reify removes the link and deletes the victim's contents). The harness never creates one and never passes one to npm.`,
    );
  }

  return true;
}

/** Bounded removal: only paths whose realpath is contained by the worktree root; symlinks are unlinked, never traversed. */
function removeWorkspaceDependencies(directory) {
  const root = safeRealpath(directory);

  assertNoSymlinkedNodeModules(directory);

  const removed = [];

  for (const path of workspaceNodeModulesPaths(directory)) {
    const real = safeRealpath(path);

    if (root === null || real === null || !isContainedBy(real, root)) {
      workspaceFail(
        WORKSPACE_EXIT_USAGE,
        `REMOVAL_NOT_CONTAINED: refusing to remove ${path} — its realpath is not contained by the worktree root. Every removal is contained; a path that fails containment is refused, not removed.`,
      );
    }

    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }

  return removed;
}

function directoryBytes(path, depth = 0) {
  if (depth > 24) {
    return 0;
  }

  let stat = null;

  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }

  if (stat.isSymbolicLink()) {
    return 0;
  }

  if (stat.isFile()) {
    return stat.size;
  }

  if (!stat.isDirectory()) {
    return 0;
  }

  let entries = null;

  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  return entries.reduce((total, entry) => total + directoryBytes(join(path, entry.name), depth + 1), 0);
}

/**
 * Reclaim. A directory under the worktree root that is NOT a registered linked worktree of this repository is refused
 * unless `--force`, so the root is never a blind `rm -rf` target. Removal failure is RETURNED, not swallowed: cleanup
 * failure had no observable signal at all before this.
 *
 * A2 — the containment test is no longer vacuous. `isContainedBy(realpath(directory), realpath(dirname(directory)))`
 * is true for EVERY path, because a directory always contains itself, so it constrained nothing; and `directory` came
 * straight out of an unauthenticated JSON field, so setting only that field to a registered worktree OUTSIDE the
 * harness root and running `workspace prune --stale-after=0s` deleted it (exit 0, no `--force`), and with `--force` even
 * an arbitrary non-worktree directory went. Two independent conditions now hold:
 *
 *   1. CONTAINMENT — `root` is the RESOLVED worktree root, not the target's own parent, and the target's realpath must
 *      be inside it. This is the SECURITY property ("not yours to delete") and NOTHING waives it: not `--force`, not a
 *      matching key, not a registered worktree. A path outside the root is refused in every mode.
 *   2. IDENTITY — `expectedDirectory` is RE-DERIVED from `workspace_key` + `workspace_instance` under that same root,
 *      exactly as `prepare` derives it, and the recorded `directory` must resolve to the same realpath. This is a
 *      CONSISTENCY property ("this record agrees with itself"), and `--force` waives it: `--force` is the shipped way
 *      for an operator to reclaim a directory under the root that this program did not create and git does not
 *      recognise, and E14-10 depends on exactly that.
 *
 * So `--force` widens the IDENTITY check only. It cannot reach outside the root, and the two questions are kept apart
 * because collapsing them would either delete a stranger's directory or turn an existing operator escape hatch into a
 * lie the error text has to apologise for.
 */
function reclaimWorkspaceInstance({ directory, root = null, expectedDirectory = null, force = false }) {
  if (root === null) {
    return { removed: false, bytes: 0, reason: 'no_worktree_root_supplied' };
  }

  const resolvedRoot = safeRealpath(root);

  if (resolvedRoot === null) {
    return { removed: false, bytes: 0, reason: 'worktree_root_unresolvable' };
  }

  if (!existsSync(directory)) {
    // A3: a directory removed out of band leaves a `git worktree` ADMIN RECORD behind, and `git worktree add` then
    // refuses with "is a missing but already registered worktree; use 'add -f' … or 'prune' or 'remove' to clear".
    // `git worktree prune` removes exactly the records whose directory is missing, which is precisely this state, so
    // the shipped removal path performs the documented recovery itself instead of advising the operator to do it by
    // hand. This is the RECOVERY, not a convenience: without it the instance stays wedged forever.
    git(['worktree', 'prune']);

    return { removed: false, bytes: 0, reason: 'absent' };
  }

  const real = safeRealpath(directory);

  // Containment runs FIRST and is never waived: an out-of-root path is refused before anything else is considered, so
  // even a perfectly matching key cannot talk this program into deleting a path it does not own.
  if (real === null || !isContainedBy(real, resolvedRoot)) {
    return { removed: false, bytes: 0, reason: 'not_contained_by_worktree_root' };
  }

  if (expectedDirectory !== null && !force) {
    const derived = safeRealpath(expectedDirectory);

    if (derived === null || safeRealpath(directory) !== derived) {
      return { removed: false, bytes: 0, reason: 'not_derived_from_key_and_instance' };
    }
  }

  // Reused, not re-derived: the same `resolveJudgedScope` the evaluation record uses.
  const registered = observeJudgedTree(directory).scope === 'linked_worktree_of_this_repo';

  if (!registered && !force) {
    return { removed: false, bytes: 0, reason: 'not_a_registered_worktree_of_this_repository' };
  }

  const bytes = directoryBytes(directory);

  if (registered && git(['worktree', 'remove', '--force', directory]) === null && !force) {
    return { removed: false, bytes: 0, reason: 'git_worktree_remove_failed' };
  }

  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    return { removed: false, bytes: 0, reason: 'rm_failed' };
  }

  if (registered) {
    git(['worktree', 'prune']);
  }

  return { removed: !existsSync(directory), bytes, reason: existsSync(directory) ? 'rm_incomplete' : 'removed' };
}

/**
 * A3 — clear a `git worktree` admin record whose directory no longer exists, and only that.
 *
 * `git worktree prune` takes no path argument, so the only control this program has is to make sure calling it is
 * SAFE: it runs only when the target path is absent, and git's own prune only ever removes records whose directory is
 * missing. A live worktree is therefore never touched, and a concurrent `regress` holding a real instance keeps it.
 */
function gitWorktreePruneStaleRecord(directory) {
  if (existsSync(directory)) {
    return false;
  }

  return git(['worktree', 'prune']) !== null;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function printWorkspaceSummary(lines) {
  process.stdout.write(`${['', ...lines, ''].join('\n')}\n`);
}

/**
 * The operator's OWN acceptances lead, because they are the facts a reader must not miss, and the harness defaults
 * follow. The record is bounded, so ordering is not cosmetic: an acceptance appended after a long default sentence can
 * be truncated away, which is exactly the case where recording it matters.
 */
function installDeviation(flags, acceptedEnv, offline, npmCache, gateEnvPolicy, buildMode = 'derived') {
  const parts = [];

  if (flags['accept-lockfile-version'] === true) {
    parts.push('the operator accepted an out-of-set lockfileVersion (--accept-lockfile-version)');
  }

  if (flags['accept-pm-mismatch'] === true) {
    parts.push('the operator accepted a packageManager-field conflict (--accept-pm-mismatch)');
  }

  if (acceptedEnv.length > 0) {
    parts.push(`the operator accepted inherited ${acceptedEnv.join(', ')} (--accept-inherited-env)`);
  }

  parts.push(
    "HUSKY=0 for the install (this repository runs `prepare: husky`, which writes core.hooksPath into the PRIMARY repository's shared .git/config) plus an explicit npm_config_* allowlist; no approval added or removed, no script suppressed by the harness",
  );

  // P0. The operator's own acceptances lead; this is a default, but it is the one default that EXECUTES HISTORICAL
  // CODE, so it is stated in the deviation line rather than left for a reader to infer from a field name.
  parts.push(
    buildMode === 'disabled'
      ? 'the historical BUILD step was DISABLED (--no-build), so a workspace whose gate needs a build output is left unbuilt on purpose and the record says so'
      : buildMode === 'declared'
        ? 'the historical build command was SUPPLIED BY THE OPERATOR (--build-command) and is recorded as a declared input, not derived from the commit'
        : "a historical BUILD step ran inside the worktree, executing the judged commit's own `build` string with NO neutraliser — a strictly larger class of historical code than the install, which runs with HUSKY=0",
  );

  if (offline) {
    parts.push('npm_config_offline=true was set by the harness (--offline)');
  }

  if (npmCache !== null) {
    parts.push('a private npm cache was supplied; the shared cache is never cleared');
  }

  if (gateEnvPolicy === 'inherited') {
    parts.push(
      'the gate child environment was the operator shell INHERITED WHOLESALE (--gate-env=inherited), so NODE_PATH, NODE_OPTIONS, npm_config_* and proxy variables reached the gate; the default is --gate-env=sanitised',
    );
  }

  return parts.join('; ').slice(0, 400);
}

/**
 * F2. The harness does not pass `--ignore-scripts` and npm does not report whether a lifecycle script ran, so the only
 * honest value of `historical_install_executed_arbitrary_scripts` is `null`. What IS observable from this program's own
 * invocation is the POLICY it applied, so that is what the record carries beside the unknown.
 */
const SCRIPT_OUTPUT_MARKERS =
  /(?:^|\n)\s*>+\s+\S+@\S+\s+(?:pre|post)?install\b|\blifecycle script\b|\bnode-gyp\b|\bprepare\b/i;

function historicalInstallScriptFacts({ skipInstall, ignoreScripts, outputTail }) {
  if (skipInstall) {
    return {
      executed: null,
      basis: 'not applicable: no install ran (--no-install), so no script could have been executed by it',
      policy: 'not_applicable',
      ignore_scripts: null,
      output_showed_script_output: null,
      basis_output: 'not applicable: no install produced output',
    };
  }

  return {
    // NEVER `true`. Asserting an unobserved fact about arbitrary code execution is the error this whole programme
    // exists to avoid, and `npm ci`'s exit code is not evidence that a lifecycle script ran.
    executed: null,
    basis:
      'unknown and unrecorded as a fact: npm does not report whether a lifecycle script ran, and this harness does not observe one. The install POLICY below is observed; the execution is not.',
    policy: ignoreScripts === true ? 'scripts_suppressed_by_ignore_scripts' : 'lifecycle_scripts_permitted',
    ignore_scripts: ignoreScripts === true,
    // Observable, and honestly weak: a marker in the captured output is evidence that output happened, never proof
    // that a script ran (npm prints script output to the same stream the harness captures, and a script may be silent).
    output_showed_script_output: outputTail === null ? null : SCRIPT_OUTPUT_MARKERS.test(outputTail),
    basis_output:
      'observed: a regex match against the install output tail this harness captured. A match is evidence that script-shaped output appeared; its absence is NOT evidence that no script ran.',
  };
}

// ---------------------------------------------------------------- P0 (new cycle) — the historical BUILD step and the build-state observation
//
// Everything in this block exists because of ONE measured defect, stated once so no later comment has to re-argue it:
// the historical evaluation predicate was CONSTANT-RED. `shared/package.json` resolves only through `./dist`, `shared/`
// declares no `prepare` script, `dist` is gitignored, and nothing in the prepared worktree ever built it — so the
// server typecheck failed with `TS2307: Cannot find module '@task-board/shared'` at 50/50 commits in a 50-commit
// window, while the UI typecheck (which maps the same name straight to `shared/src`) would have passed. The capability
// existed once: the deprecated `.harness/operator/prepare-workspace.sh` ran `npm run build --workspace=shared` inside
// the worktree. It was lost when the runtime command replaced the script, and no recorded field could see it, because
// the deciding bytes live in the SOURCE tree (`shared/dist`) while the fingerprint digests `node_modules` and
// `status_hash` is a digest of `git status` WITHOUT `--ignored`.

/**
 * Bumped whenever the DERIVATION rule changes. It is part of the reuse key, so a rule change reclaims every
 * workspace rather than silently reusing one verified under a different rule.
 *
 * F2 deliberately did NOT bump it, and the reason is worth stating rather than leaving to inference. What changed is
 * the REFUSAL policy, not the DERIVATION: which packages need building for a given gate is untouched, and for every
 * commit this version can still reach the derived plan is byte-identical — a commit with no unenumerable pattern
 * derives `build_plan_undetermined_patterns: []`, which contributes nothing new to the digest. A commit WITH such a
 * pattern is now REFUSED before a workspace key is computed, so it can never reach a reuse decision at all, and no
 * attestation prepared under the old policy can be handed back by the new one. Bumping would have reclaimed every
 * workspace on the strength of a change that cannot affect any of them.
 */
const BUILD_PLAN_RULE_VERSION = 2;
/**
 * A7: the record must never say "no build output is required by this gate" when the gate does require one.
 *
 * Accepting bare relative specifiers removes the MEASURED case (`"main": "dist/index.js"`), but a plan rule that can be
 * defeated by a manifest spelling is not a fix. So the residual is a REFUSAL rather than a guess: when a considered
 * package declares a `main`/`types`/`typings` value this program cannot read as a path at all, the commit is refused
 * as `build_plan_undetermined` BEFORE any installation, and the raw value is printed. A refused commit is undecidable;
 * a silently-skipped package yields a green or a red the plan invented.
 *
 * F2 (A7 residual, second spelling). The SAME defect had a second spelling, on the OTHER side of the plan: a
 * `workspaces` pattern this program cannot enumerate as literal relative directories. With `"workspaces": ["pkgs/*"]`
 * the derived plan had `packages_considered: 0` and `unresolved_workspace_patterns: ["pkgs/*"]`, the build step was
 * `not_run`, and `build_state_basis` then read "...so no package needs building for this gate..." — the exact sentence
 * this basis forbids — after which the gate failed for a missing build output and a provisioning failure came back
 * attributed to the commit. Recording the pattern as `unresolved_workspace_patterns` made the gap VISIBLE and still
 * produced the false claim, which is worse than not looking: the reader is handed a field that reads like a disclosure
 * and a basis that reads like a conclusion.
 *
 * Enumerating a glob SOUNDLY was considered and rejected, and the rejection is part of the answer. npm's `workspaces`
 * glob is real semantics (map-workspaces/glob, with negation `!` patterns, character classes and a depth implied by
 * the pattern), and an approximation of it — `git ls-tree` filtered by a prefix regex — is a NEW way to be partially
 * wrong, in exactly the class of defect this basis exists to stop. A refusal is decidable in one line and never wrong.
 */
const BUILD_PLAN_UNDETERMINED_BASIS =
  'BUILD_PLAN_UNDETERMINED: the build plan for this commit could not be DETERMINED, in one of two ways, both refused BEFORE any installation. (1) A considered package declares a `main`/`types`/`typings` value this program cannot read as a path, so it cannot say whether the gate resolves that package through a build output. (2) A `workspaces` pattern this program cannot enumerate as a literal relative directory (a glob, a `..` segment, or a negation) — the workspace set is then only partially known, so the plan derived from it is a plan over an UNKNOWN subset, and a plan over an unknown subset is not evidence that nothing needs building. Refusing is the fail-closed answer: an undetermined plan is NOT recorded as "no build output is required by this gate", because that sentence is a claim the gate can contradict on its very next step, and a partially-enumerated workspace is exactly how that claim was made false. A refused commit is UNDECIDABLE, not red: neither the harness nor git ever scored it. Enumerating a glob soundly was considered and rejected — npm `workspaces` globs carry real semantics (negation, character classes, pattern-implied depth) and a prefix-filter approximation of them is a new way to be partially wrong.';
/** Stated once, in the record: what "needs building" means, so a reader can disagree with the rule rather than guess it. */
const BUILD_PLAN_SELECTION_RULE =
  'a workspace package is built when ALL FOUR hold, all read from the judged commit\'s own manifests: (1) it declares a `build` script; (2) it declares at least one relative entrypoint (`main`/`types`/`typings`/`exports`); (3) at least one of those entrypoints is NOT tracked at that commit, i.e. the package is not built in a fresh checkout; (4) some other manifest at that commit depends on it by a LOCAL spec (`workspace:`, `file:`, `*`, or a range equal to the local version). Conditions (2)-(3) are what make a package resolvable-only-after-a-build the target, and (4) is what keeps an unreferenced package out of the plan. In (2) a BARE relative specifier counts: Node resolves `main`/`types`/`typings` with path.resolve(packageDirectory, value), so `"main": "dist/index.js"` is a path relative to the package directory exactly as `"main": "./dist/index.js"` is, while `exports` keys and targets still require an explicit `./`, `../` or `/` prefix because Node\'s subpath matching does. A `main`/`types`/`typings` value this program cannot read as a path at all makes the plan UNDETERMINED and the commit is refused rather than reported as needing no build output. A `workspaces` pattern that is not a literal relative directory (a glob, a negation, a `..` segment) likewise makes the plan UNDETERMINED and refuses the commit, because the workspace set is then only PARTIALLY known and a plan over an unknown subset is not evidence that nothing needs building. The ROOT package is never a build target: its `build` orchestrates workspaces rather than producing an entrypoint, and its value is recorded but not run';
const BUILD_STATE_NOT_APPLICABLE_BASIS =
  "not applicable: the plan derived from this commit's own manifests and the resolved gate is EMPTY, so no package needs building for this gate and there is no build state to observe. This is a derivation result, not a failure to observe, and it is recorded as such rather than as a silent null";
/** The build state is read AFTER the build, from the worktree, under the same constructed environment as the install. */
const BUILD_STATE_READ_BASIS =
  'observed AFTER the historical build, inside the worktree, with the same constructed child environment the install and the gate received';

function gitPathTrackedAtCommit(commit, path) {
  return spawnSync('git', ['cat-file', '-e', `${commit}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8' }).status === 0;
}

/** A dependency spec that names the LOCAL workspace package rather than the registry. */
function localWorkspaceSpec(spec, version) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    return false;
  }

  const value = spec.trim();

  if (value === '*' || value === 'latest' || value.startsWith('workspace:') || value.startsWith('file:')) {
    return true;
  }

  const base = value.replace(/^[\^~<>= ]*/, '');

  return typeof version === 'string' && base !== '' && base === version;
}

/**
 * The manifest fields whose string value is a PATH, as opposed to the fields whose string value is a subpath KEY.
 *
 * The distinction is Node's own and it is not cosmetic. `main`/`types`/`typings` go through `legacyMainResolve`, which
 * does `path.resolve(packageDirectory, value)` — so a NON-ABSOLUTE value there is a path RELATIVE TO THE PACKAGE
 * DIRECTORY, and `"main": "dist/index.js"` resolves to `<package>/dist/index.js` exactly as `"main": "./dist/index.js"`
 * does. `exports` does not: its keys are subpath names that must begin with `./`, and its targets must begin with
 * `./` or `../`, so a bare `dist/index.js` there is a key that can never match and is emphatically not a path.
 */
const PACKAGE_PATH_FIELDS = ['main', 'types', 'typings'];

/** A `main`/`types`/`typings` value is a path unless it is a glob, a built-in specifier, or a bare directory reference. */
function declaredPathValue(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  return (
    trimmed !== '' &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    !trimmed.includes('*') &&
    !trimmed.startsWith('node:') &&
    !trimmed.startsWith('#')
  );
}

/** An `exports` KEY or TARGET is a path only when it carries an explicit relative or absolute prefix. */
function declaredExportsValue(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  return (
    trimmed !== '' &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    !trimmed.includes('*') &&
    !trimmed.startsWith('node:') &&
    (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/'))
  );
}

/** The `main`/`types`/`typings` values a manifest declares that this program cannot read as a path at all. */
function undeterminedEntrypointFields(pkg) {
  return PACKAGE_PATH_FIELDS.filter(
    (field) => typeof pkg?.[field] === 'string' && pkg[field].trim() !== '' && !declaredPathValue(pkg[field]),
  ).map((field) => ({ field, value: optionalTextOrNull(pkg[field], 200) }));
}

/** Relative entrypoints a package declares, normalised and deduplicated. */
function declaredEntrypoints(pkg) {
  const values = new Set();
  const pushWith = (predicate) => (value) => {
    if (predicate(value)) {
      values.add(value.trim().replace(/^\.\//, ''));
    }
  };
  const pushPath = pushWith(declaredPathValue);
  const pushExport = pushWith(declaredExportsValue);
  const walk = (node, push) => {
    if (typeof node === 'string') {
      push(node);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, push));
      return;
    }

    if (node !== null && typeof node === 'object') {
      Object.values(node).forEach((item) => walk(item, push));
    }
  };

  // A BARE relative specifier is a path in these fields, because Node says it is one (see PACKAGE_PATH_FIELDS). The
  // previous rule required a `./` prefix, so `"main": "dist/index.js"` produced NO entrypoint: the package was
  // skipped with "no relative entrypoint declared", `build_state` was recorded as "not applicable (no build output is
  // required by this gate)", and the gate then failed with `shared/dist/index.js missing` — which `regress` scored as
  // a `regression` / `test_failure` ATTRIBUTED TO THE COMMIT. A narrower manifest spelling recreated, through the plan,
  // the exact constant-red defect the build step exists to remove.
  for (const field of PACKAGE_PATH_FIELDS) {
    pushPath(pkg?.[field]);
  }

  walk(pkg?.exports, pushExport);

  return [...values].sort();
}

/**
 * The plan, derived from the judged commit's OWN manifests. Every input is `git show <commit>:<path>`, so the plan
 * exists BEFORE any worktree does and a refusal or a plan change costs no installation.
 */
function historicalBuildPlanForCommit(commit) {
  const root = readHistoricalManifest(commit, 'package.json');
  const declared = Array.isArray(root?.workspaces)
    ? root.workspaces
    : Array.isArray(root?.workspaces?.packages)
      ? root.workspaces.packages
      : [];
  const unresolvedPatterns = [];
  const directories = [];

  for (const pattern of declared) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      continue;
    }

    const trimmed = pattern.trim().replace(/\/+$/, '');

    // A GLOB in `workspaces` is legal npm. This harness resolves only literal relative directory paths, and F2 makes
    // an UNENUMERABLE pattern REFUSE the commit rather than merely record it: recording it made the gap visible and
    // still let the plan claim "no package needs building for this gate" over a workspace set this program had only
    // partially read. The pattern is still RECORDED — the reader sees what was refused and why — but it is no longer
    // a note; it is the second cause of `build_plan_undetermined`.
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(trimmed) || trimmed.split('/').includes('..')) {
      unresolvedPatterns.push(pattern);
      continue;
    }

    if (!directories.includes(trimmed)) {
      directories.push(trimmed);
    }
  }

  const considered = directories.slice(0, BUILD_MAX_WORKSPACE_PACKAGES);
  const packages = [];
  const manifests = [];

  for (const dir of considered) {
    const manifest = readHistoricalManifest(commit, `${dir}/package.json`);

    if (manifest === null || typeof manifest?.name !== 'string' || manifest.name === '') {
      continue;
    }

    const entry = {
      dir,
      name: manifest.name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      build_script: typeof manifest.scripts?.build === 'string' ? manifest.scripts.build : null,
      entrypoints: declaredEntrypoints(manifest),
      undetermined_entrypoint_fields: undeterminedEntrypointFields(manifest),
      local_dependencies: [],
      local_dependents: [],
    };

    packages.push(entry);
    manifests.push(entry);
  }

  manifests.push({
    dir: '.',
    name: typeof root?.name === 'string' ? root.name : null,
    version: typeof root?.version === 'string' ? root.version : null,
    build_script: typeof root?.scripts?.build === 'string' ? root.scripts.build : null,
    entrypoints: declaredEntrypoints(root),
    undetermined_entrypoint_fields: undeterminedEntrypointFields(root),
    local_dependencies: [],
    local_dependents: [],
  });

  // The local dependency graph, over LOCAL specs only. A registry range never points at a workspace package, so
  // counting one as local would put an unrelated package into the plan on the strength of a version match alone.
  for (const consumer of manifests) {
    const manifest = consumer.dir === '.' ? root : readHistoricalManifest(commit, `${consumer.dir}/package.json`);

    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
        const provider = packages.find((candidate) => candidate.name === name);

        if (provider !== undefined && provider !== consumer && localWorkspaceSpec(spec, provider.version)) {
          provider.local_dependents.push(`${consumer.dir}:${field}`);
          consumer.local_dependencies.push(name);
        }
      }
    }
  }

  for (const entry of packages) {
    entry.local_dependents.sort();
    entry.local_dependencies.sort();
  }

  const evaluated = packages.map((entry) => {
    const untracked = entry.entrypoints.filter(
      (relative) => !gitPathTrackedAtCommit(commit, `${entry.dir}/${relative}`),
    );
    const parents = [...new Set(entry.entrypoints.map((relative) => dirname(relative)))].filter(
      (parent) => parent !== '.' && parent !== '' && parent !== '/',
    );
    // A package whose entrypoint sits at its own root (`main: "index.js"`) has no output DIRECTORY, so the entrypoint
    // FILES are the observable build output instead. Falling back to the whole package directory would fold the
    // package's own source into the build-state digest and make any gate-run write look like a rebuild.
    const outputFiles = entry.entrypoints.map((relative) => `${entry.dir}/${relative}`);

    return {
      dir: entry.dir,
      name: entry.name,
      build_script: entry.build_script,
      entrypoints: entry.entrypoints,
      untracked_entrypoints: untracked,
      undetermined_entrypoint_fields: entry.undetermined_entrypoint_fields,
      output_roots: parents.length > 0 ? parents.map((parent) => `${entry.dir}/${parent}`).sort() : outputFiles,
      output_kind: parents.length > 0 ? 'directories' : 'files',
      local_dependents: entry.local_dependents,
      selected:
        entry.build_script !== null &&
        entry.entrypoints.length > 0 &&
        untracked.length > 0 &&
        entry.local_dependents.length > 0,
    };
  });

  // Deterministic order: a dependency before its dependents, name as the tie-break, and a cycle broken by name rather
  // than by whichever package happened to be read first. A build whose order is not pinned is not a plan.
  const selectedNames = evaluated
    .filter((entry) => entry.selected)
    .map((entry) => entry.name)
    .sort();
  const remaining = new Set(selectedNames);
  const ordered = [];

  while (remaining.size > 0) {
    const ready = selectedNames.filter(
      (name) =>
        remaining.has(name) &&
        (evaluated.find((candidate) => candidate.name === name)?.local_dependencies ?? []).every(
          (dependency) => !remaining.has(dependency),
        ),
    );
    const batch = (ready.length === 0 ? [...remaining] : ready).sort();

    ordered.push(batch[0]);
    remaining.delete(batch[0]);
  }

  const plan = {
    rule_version: BUILD_PLAN_RULE_VERSION,
    selection_rule: BUILD_PLAN_SELECTION_RULE,
    packages_considered: considered.length,
    packages: ordered.map((name) => evaluated.find((entry) => entry.name === name)).filter(Boolean),
    // The REJECTED candidates are recorded too, so "why was nothing built for that package" is answerable from the
    // record itself instead of from a re-derivation by the reader.
    packages_skipped: evaluated
      .filter((entry) => !entry.selected)
      .map((entry) => ({
        dir: entry.dir,
        name: entry.name,
        reason:
          entry.build_script === null
            ? 'no build script declared at this commit'
            : entry.entrypoints.length === 0
              ? 'no relative entrypoint declared (main/types/typings/exports), so the gate does not resolve this package through a build output'
              : entry.untracked_entrypoints.length === 0
                ? 'every declared entrypoint is already TRACKED at this commit, so the package needs no build in a fresh checkout'
                : 'no other manifest at this commit depends on it by a local spec',
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    unresolved_workspace_patterns: unresolvedPatterns,
    // F2, additive and always present: the patterns that made the workspace set only PARTIALLY known, each with the
    // reason it could not be enumerated. Non-empty means the same thing `build_plan_undetermined` means for an
    // unreadable entrypoint, and the caller refuses on it for the same reason. A plan that never had a `workspaces`
    // field at all gets `[]`, not null, so a reader never has to distinguish "not recorded" from "none".
    build_plan_undetermined_patterns: unresolvedPatterns.map((pattern) => ({
      pattern,
      reason: /[*?[\]!]/.test(pattern)
        ? 'a GLOB or negated pattern: npm `workspaces` globs carry real semantics (negation, character classes, pattern-implied depth) and this program enumerates only literal relative directories, so approximating them would be a new way to be partially wrong'
        : 'not a literal relative directory path resolvable from the commit root',
    })),
    truncated: directories.length > considered.length,
    // A7: a package whose primary resolution field this program cannot read. Non-empty means the plan is
    // UNDETERMINED for that package, and the caller refuses the commit rather than claiming no build is required.
    // The root package is included: a root `main` is what `require('<repo>')` resolves.
    build_plan_undetermined: manifests
      .filter((entry) => entry.undetermined_entrypoint_fields.length > 0)
      .map((entry) => ({ dir: entry.dir, name: entry.name, fields: entry.undetermined_entrypoint_fields }))
      .sort((left, right) => `${left.dir}`.localeCompare(`${right.dir}`)),
    build_plan_undetermined_basis: BUILD_PLAN_UNDETERMINED_BASIS,
    // Recorded, not run: the root `build` orchestrates workspaces. A reader can see what it would have been.
    root_build_script: typeof root?.scripts?.build === 'string' ? root.scripts.build : null,
    command_basis: BUILD_COMMAND_BASIS,
  };

  plan.digest = digest16(
    canonicalJson({
      rule_version: BUILD_PLAN_RULE_VERSION,
      packages: plan.packages.map((entry) => ({
        dir: entry.dir,
        name: entry.name,
        build_script: entry.build_script,
        entrypoints: entry.entrypoints,
        output_roots: entry.output_roots,
        output_kind: entry.output_kind,
      })),
      unresolved_workspace_patterns: plan.unresolved_workspace_patterns,
      build_plan_undetermined_patterns: plan.build_plan_undetermined_patterns,
      truncated: plan.truncated,
      build_plan_undetermined: plan.build_plan_undetermined,
    }),
  );

  return plan;
}

/**
 * `--build-command` is an ARGV, never a shell line. A shell string would be a second, larger execution class layered on
 * top of the one the record already discloses, and it would be evaluated by whichever shell the operator happens to
 * have. The harness spawns the program directly, and a metacharacter is refused with a message that says why.
 */
const BUILD_COMMAND_METACHARACTERS = /[|&;<>()$`\\"'*?~!#\n\r{}[\]]/;

function parseDeclaredBuildCommand(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      '--build-command requires a non-empty command, e.g. --build-command=npm run build --workspace=shared',
    );
  }

  if (BUILD_COMMAND_METACHARACTERS.test(raw)) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `BUILD_COMMAND_SHELL_METACHARACTERS: --build-command=${raw} contains a shell metacharacter. This harness never runs a shell for a build: the string is split on whitespace into an argv and spawned directly, because a shell string would be a strictly larger and less observable class of historical code execution than the one the record already discloses.`,
    );
  }

  return raw.trim().split(/\s+/);
}

function formatArgv(argv) {
  return argv.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

/**
 * The build, in the worktree, under the SAME constructed child environment as the install, with an outcome recorded
 * exactly like the install's: mode, outcome, exit code, duration and a bounded output tail.
 *
 * A build that fails is a PRE-EVALUATION failure of the same class as a failed install: the caller turns it into
 * `unusable` and exit 5, and the record names it. "Usable, but the gate will fail for an unrecorded reason" is the
 * state this whole increment exists to destroy.
 */
/** Names recorded per root, and names CHANGED per root. The observation is a disclosure, so it is bounded hard. */
const BUILD_ESCAPE_MAX_NAMES = 200;
/** How many ADDED / REMOVED names are printed per root before the list itself is declared truncated. */
const BUILD_ESCAPE_MAX_CHANGES = 20;

/**
 * A8: what a build did OUTSIDE the worktree, bounded, and what this program cannot see.
 *
 * A build executes the judged commit's own `build` string with the OPERATOR's privileges on the OPERATOR's filesystem.
 * A worktree is a place on a filesystem, not a boundary: a build may write to `/tmp/…`, to `$HOME`, or anywhere else,
 * and the measured case (a build writing `/tmp/fixshared/` and into `$HOME`) produced `build: derived -> succeeded`,
 * `workspace: usable`, and no attestation field mentioning it at all. Silence about a class of effect this program can
 * SEE happening is the defect; so this records a pre/post observation of three named roots, and — as data, in the
 * same record — names the class it does not observe.
 *
 * What is observed: the top-level NAMES of the worktree's parent directory, the system temp directory, and the home
 * directory, before and after the build, with a digest of each name set. A name appearing or disappearing is DETECTED.
 *
 * What is NOT observed, and is recorded as such rather than left to a reader's imagination: a write INSIDE a directory
 * that already existed (its name set does not change), a change to a file's contents, and any write to any of the
 * unbounded remainder of the filesystem. This is a DETECTION and OBSERVABILITY limit, not PREVENTION: nothing here
 * stops a build writing anywhere, and a `false` on `outside_worktree_write_detected` means "no top-level name changed",
 * never "the build wrote nothing outside the worktree".
 */
const BUILD_ESCAPE_UNOBSERVED =
  "a write INSIDE a directory that already existed is NOT detected (its top-level name set does not change), a change to a FILE's CONTENTS is NOT detected (only names are compared), and any write to the unbounded remainder of the filesystem is NOT detected at all. outside_worktree_write_detected: false means no top-level name changed in the three probed roots, never that the build wrote nothing outside the worktree.";
const BUILD_ESCAPE_BASIS =
  "observed: the top-level NAMES of three named roots (the parent directory of the worktree, the system temp directory, and the home directory) were listed before and after the historical build and the name sets were compared. A worktree is not a security boundary and this is a DETECTION and OBSERVABILITY limit, not PREVENTION: the build ran with the operator's privileges on the operator's filesystem, nothing here confined it, and the unobserved class is named in the same record rather than left unstated.";

/**
 * The top-level NAME SET of one directory. It never opens a file and never reads a byte of content.
 *
 * The FULL sorted set is returned even though the record PRINTS only a bounded slice, because the slice is a PRINT
 * bound and the comparison is not: truncating before the diff would put a new entry beyond the cap and report a
 * changed root with an empty `added` list, which is the "changed but unexplained" shape this observation exists to
 * avoid. The digest has always been over the whole set.
 */
function boundedDirectoryNames(directory) {
  let listing = null;

  try {
    listing = readdirSync(directory);
  } catch {
    return { readable: false, count: null, digest: null, names: null, truncated: null };
  }

  const names = listing.map((name) => `${name}`).sort();

  return {
    readable: true,
    count: names.length,
    digest: digest16(canonicalJson(names)),
    names,
    truncated: names.length > BUILD_ESCAPE_MAX_NAMES,
  };
}

/** The roots a build's escape is looked for in. Paths are carried but DIGESTED, never printed. */
function buildEscapeRoots(directory) {
  const roots = [{ kind: 'worktree_parent', path: dirname(directory) }];
  let home = null;
  let temp = null;

  try {
    home = homedir();
  } catch {
    home = null;
  }

  try {
    temp = tmpdir();
  } catch {
    temp = null;
  }

  if (typeof home === 'string' && home !== '' && isAbsolute(home) && !roots.some((root) => root.path === home)) {
    roots.push({ kind: 'home', path: home });
  }

  if (typeof temp === 'string' && temp !== '' && isAbsolute(temp) && !roots.some((root) => root.path === temp)) {
    roots.push({ kind: 'system_tmp', path: temp });
  }

  return roots;
}

function beginBuildEscapeObservation(directory) {
  return buildEscapeRoots(directory).map((root) => ({
    kind: root.kind,
    path: root.path,
    path_digest: digest16(root.path),
    before: boundedDirectoryNames(root.path),
  }));
}

/** The AFTER half. Disclosive only: nothing here decides a verdict, an exit code or a workspace state. */
function finishBuildEscapeObservation(before) {
  const roots = before.map((entry) => {
    const after = boundedDirectoryNames(entry.path);
    const base = { kind: entry.kind, path_digest: entry.path_digest };

    if (!entry.before.readable || !after.readable) {
      return {
        ...base,
        readable: false,
        before_count: entry.before.count,
        after_count: after.count,
        before_digest: entry.before.digest,
        after_digest: after.digest,
        added: null,
        removed: null,
        added_count: null,
        removed_count: null,
        truncated: null,
        changed: null,
        basis: 'not observed: this root could not be listed, so nothing is claimed about it in either direction',
      };
    }

    const beforeNames = new Set(entry.before.names);
    const afterNames = new Set(after.names);
    const added = after.names.filter((name) => !beforeNames.has(name));
    const removed = entry.before.names.filter((name) => !afterNames.has(name));

    return {
      ...base,
      readable: true,
      before_count: entry.before.count,
      after_count: after.count,
      before_digest: entry.before.digest,
      after_digest: after.digest,
      // BOUNDED: a build creating thousands of top-level entries is reported as a count and a digest, with at most
      // BUILD_ESCAPE_MAX_CHANGES names printed and `truncated` saying which happened. The COMPARISON uses the full
      // name sets, not the printed slice, so a change beyond the print bound is still a detected change.
      added: added.slice(0, BUILD_ESCAPE_MAX_CHANGES),
      removed: removed.slice(0, BUILD_ESCAPE_MAX_CHANGES),
      added_count: added.length,
      removed_count: removed.length,
      truncated: added.length > BUILD_ESCAPE_MAX_CHANGES || removed.length > BUILD_ESCAPE_MAX_CHANGES,
      changed: entry.before.digest !== after.digest,
      basis: null,
    };
  });

  const changedRoots = roots.filter((entry) => entry.changed === true).map((entry) => entry.kind);

  return {
    observable: 'top_level_names_of_three_named_roots',
    roots,
    changed_roots: changedRoots,
    outside_worktree_write_detected: changedRoots.length > 0,
    // Never `true`: this is the class the record admits it does NOT measure, as data. A reader asking what a build can
    // do that this field cannot see reads THIS one, not the prose.
    outside_worktree_writes_fully_observed: false,
    unobserved_class: BUILD_ESCAPE_UNOBSERVED,
    prevention:
      'none: a worktree is not a security boundary. This is a DETECTION and OBSERVABILITY limit, not prevention.',
    basis: BUILD_ESCAPE_BASIS,
  };
}

function runHistoricalBuild({ directory, childEnv, plan, mode, declaredArgv }) {
  const startedAt = new Date();
  const startedMs = Date.now();
  const steps = [];
  if (mode === 'disabled') {
    // A DISABLED build is recorded as a disabled build, never as a build that passed and never as a build that found
    // nothing to do. Those are three different operator acts and only the middle one is evidence of anything.
    return {
      mode,
      outcome: 'disabled',
      command: null,
      command_basis:
        'not applicable: the operator disabled the build step (--no-build), which is recorded as a deviation and never as a build that passed',
      plan_digest: null,
      packages: [],
      exit_code: null,
      duration_ms: 0,
      output_tail: null,
      started_at: startedAt.toISOString(),
      finished_at: startedAt.toISOString(),
      // A disabled build ran NO historical code, so there is nothing to have escaped the worktree. Recorded as that
      // fact, not as an escape observation that found nothing.
      outside_worktree_writes: {
        observable: 'not_applicable',
        roots: [],
        changed_roots: [],
        outside_worktree_write_detected: null,
        outside_worktree_writes_fully_observed: false,
        unobserved_class: BUILD_ESCAPE_UNOBSERVED,
        prevention: 'none: a worktree is not a security boundary.',
        basis:
          'not applicable: the build step was DISABLED (--no-build), so no historical build string ran and there was nothing that could have written outside the worktree',
      },
    };
  }

  const invocation =
    mode === 'declared'
      ? [{ package: null, argv: declaredArgv }]
      : plan.packages.map((entry) => ({
          package: entry.name,
          argv: ['npm', 'run', 'build', `--workspace=${entry.name}`],
        }));

  // The tail is accumulated per step and bounded ONCE at the end, so a chatty historical build cannot make the record
  // large: the bound is a property of the RECORD, not of how much the build happened to print.
  const outputChunks = [];
  // A8: the BEFORE half is taken here, immediately before the first historical process is spawned, so the comparison
  // brackets the build itself and not the rest of provisioning.
  const escapeBefore = beginBuildEscapeObservation(directory);

  for (const { package: packageName, argv } of invocation) {
    const stepStartedMs = Date.now();
    const result = spawnSync(argv[0], argv.slice(1), { cwd: directory, encoding: 'utf8', env: childEnv });
    const exitCode = Number.isInteger(result.status) ? result.status : null;

    outputChunks.push(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    steps.push({
      package: packageName,
      command: formatArgv(argv),
      exit_code: exitCode,
      duration_ms: Date.now() - stepStartedMs,
    });

    // Fail fast, exactly as a gate step does: a package whose build failed cannot make its dependents buildable.
    if (exitCode !== 0) {
      break;
    }
  }

  const failed = steps.length > 0 && steps[steps.length - 1].exit_code !== 0;

  return {
    mode,
    outcome: steps.length === 0 ? 'not_run' : failed ? 'failed' : 'succeeded',
    command: optionalTextOrNull(steps.map((step) => step.command).join(' && '), BUILD_COMMAND_MAX_CHARS),
    command_basis: mode === 'declared' ? BUILD_COMMAND_DECLARED_BASIS : BUILD_COMMAND_BASIS,
    plan_digest: mode === 'derived' ? plan.digest : null,
    packages: steps,
    exit_code: steps.length === 0 ? null : steps[steps.length - 1].exit_code,
    duration_ms: Date.now() - startedMs,
    output_tail: tailLines(outputChunks.join('\n'), BUILD_OUTPUT_TAIL_LINES, BUILD_OUTPUT_TAIL_MAX_CHARS) || null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    // A8. Recorded on BOTH outcomes, including a failed build: a build that failed is exactly as capable of writing
    // outside the worktree as one that succeeded, and the measured case was a SUCCEEDING build.
    outside_worktree_writes: finishBuildEscapeObservation(escapeBefore),
  };
}

/**
 * The IGNORED paths of ONE worktree, read by git with the worktree as its cwd and `--no-optional-locks` so it cannot
 * write the primary repository's index. NAMES only: `git status` prints a path, and this program never opens one.
 */
function observeIgnoredPaths(directory, childEnv) {
  const args = ['--no-optional-locks', 'status', '--porcelain', '--ignored=traditional'];
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...childEnv, GIT_OPTIONAL_LOCKS: '0' },
  });

  if (result.status !== 0) {
    return {
      command: `git ${args.join(' ')}`,
      readable: false,
      count: null,
      digest: null,
      names: [],
      truncated: false,
    };
  }

  const names = `${result.stdout ?? ''}`
    .split('\n')
    .map((line) => (line.startsWith('!! ') ? line.slice(3).trim() : null))
    .filter((line) => line !== null && line !== '');

  return {
    command: `git ${args.join(' ')}`,
    readable: true,
    count: names.length,
    digest: digest16(canonicalJson([...names].sort())),
    names: names.slice(0, BUILD_STATE_MAX_IGNORED_PATHS),
    truncated: names.length > BUILD_STATE_MAX_IGNORED_PATHS,
  };
}

/** A bounded, content-tier walk of ONE declared build-output directory. `null` on any failure: never a weaker tier. */
function walkBuildOutputDirectory(directory) {
  const lines = [];
  let failed = false;

  const walk = (absolute, depth) => {
    if (failed) {
      return;
    }

    if (depth > BUILD_STATE_MAX_DEPTH || lines.length > BUILD_STATE_MAX_ENTRIES) {
      failed = true;
      return;
    }

    let listing = null;

    try {
      listing = readdirSync(absolute, { withFileTypes: true });
    } catch {
      failed = true;
      return;
    }

    for (const item of [...listing].sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(absolute, item.name);
      const relative = pathRelative(directory, child);

      if (item.isSymbolicLink()) {
        let target = null;

        try {
          target = readlinkSync(child);
        } catch {
          failed = true;
          return;
        }

        lines.push(`L|${relative}|${target}`);
        continue;
      }

      if (item.isDirectory()) {
        walk(child, depth + 1);
        continue;
      }

      if (!item.isFile()) {
        continue;
      }

      const content = hashFileBytes16(child);

      if (content === null) {
        failed = true;
        return;
      }

      lines.push(`F|${relative}|${content}`);
    }
  };

  walk(directory, 0);

  return failed || lines.length === 0 ? null : { digest: digest16(lines.join('\n')), entries: lines.length };
}

/**
 * The BUILD STATE: the bytes the gate depends on, plus the ignored-path NAMES. `observed: false` is a failure to
 * observe and is worded as one, because "not observed" and "absent" are different facts and conflating them would
 * write a false reason into a durable record.
 */
function observeBuildState(directory, plan, childEnv) {
  const ignored = observeIgnoredPaths(directory, childEnv);
  const regions = [];

  for (const entry of plan.packages) {
    for (const output of entry.output_roots) {
      const absolute = join(directory, output);
      let stat = null;

      try {
        stat = lstatSync(absolute);
      } catch {
        stat = null;
      }

      if (stat === null) {
        regions.push({ path: output, kind: entry.output_kind, present: false, entries: null, digest: null });
        continue;
      }

      if (entry.output_kind === 'files' || !stat.isDirectory()) {
        const content = stat.isFile() ? hashFileBytes16(absolute) : null;

        regions.push({
          path: output,
          kind: 'files',
          present: true,
          // A path declared as a FILE that turned out to be a directory (or the reverse) is a real observation and is
          // recorded as one, never flattened into "missing".
          shape_matches: entry.output_kind === 'files' ? stat.isFile() : stat.isDirectory(),
          entries: content === null ? null : 1,
          digest: content,
        });
        continue;
      }

      const walked = walkBuildOutputDirectory(absolute);

      regions.push(
        walked === null
          ? { path: output, kind: 'directories', present: true, entries: null, digest: null, unwalkable: true }
          : { path: output, kind: 'directories', present: true, entries: walked.entries, digest: walked.digest },
      );
    }
  }

  const observed = ignored.readable && regions.every((region) => region.present && region.digest !== null);

  return {
    observed,
    basis: observed
      ? `${BUILD_STATE_READ_BASIS}; ${regions.length} declared build-output region(s) walked at the content tier, and ${ignored.count} ignored path NAME(s) read by \`${ignored.command}\` with the worktree as its cwd, so the primary checkout is neither read nor written`
      : BUILD_STATE_UNOBSERVED_BASIS,
    tier: 'content',
    digest: observed ? digest16(canonicalJson(regions)) : null,
    regions,
    missing_outputs: regions.filter((region) => !region.present).map((region) => region.path),
    unwalkable_outputs: regions.filter((region) => region.unwalkable === true).map((region) => region.path),
    ignored,
    limitation: BUILD_STATE_LIMITATION,
  };
}

function cmdWorkspace(args) {
  const [sub = 'list', ...rest] = args;
  // The subcommand is consumed here, so the flag boundary is per SUBcommand: `workspace prepare` and `workspace prune`
  // have almost disjoint flag sets, and an allowlist spanning both would accept `--commit` on a prune and hide a typo.
  const flags = parseFlags(rest, { command: 'workspace', subcommand: sub });

  switch (sub) {
    case 'prepare':
      return cmdWorkspacePrepare(flags);
    case 'remove':
      return cmdWorkspaceRemove(flags);
    case 'prune':
      return cmdWorkspacePrune(flags);
    case 'show':
      return cmdWorkspaceShow(flags);
    case 'list':
      return cmdWorkspaceList();
    default:
      fail(`unknown workspace subcommand "${sub}" — prepare | remove | prune | show | list`);
      return WORKSPACE_EXIT_USAGE;
  }
}

function cmdWorkspacePrepare(flags) {
  const requestedRef = typeof flags.commit === 'string' ? flags.commit.trim() : null;

  if (requestedRef === null || requestedRef === '') {
    workspaceFail(WORKSPACE_EXIT_USAGE, 'workspace prepare requires --commit=<ref>');
  }

  const instance = workspaceInstance(flags);
  const acceptedEnv = acceptedInheritedEnvNames(flags);
  const offline = flags.offline === true;
  const skipInstall = flags['no-install'] === true;
  const keep = flags.keep === true;
  // P0. The build is ON by default, disableable, and overridable with an explicitly DECLARED command. The two flags
  // are mutually exclusive because "do not build" and "build exactly this" are contradictory instructions, and
  // accepting both would leave the recorded mode to whichever branch happened to be evaluated first.
  const buildDisabled = flags['no-build'] === true;
  const declaredBuildRaw = typeof flags['build-command'] === 'string' ? flags['build-command'] : null;

  if (buildDisabled && declaredBuildRaw !== null) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      'BUILD_FLAGS_CONFLICT: --no-build and --build-command are contradictory (do not build / build exactly this). Supply one or neither.',
    );
  }
  const gateName = typeof flags.gate === 'string' ? flags.gate : DEFAULT_GATE;
  // The tier is part of the reuse key, so it is resolved and refused on BEFORE any key is computed: an unrecognised
  // tier must never be able to select a workspace verified under a rule this build does not implement.
  const fingerprintTier = treeFingerprintTierOrFail(flags.fingerprint, TREE_FINGERPRINT_DEFAULT_TIER);
  // `--gate-env` is in this subcommand's allowlist because `regress` and `census` forward it to their `prepare` child,
  // and this command's own gate child is not run here — but an unrecognised VALUE used to be accepted and then never
  // read, which is the same "a real request, not granted, not detectable" class as a dropped flag. It is refused by name
  // here with the SAME reason every other command prints.
  assertGateEnvFlagValue(flags, (refusal) => {
    workspaceFail(WORKSPACE_EXIT_USAGE, [`${refusal.name}: ${refusal.reason}`, ...refusal.lines].join('\n'));
  });

  if (!Object.hasOwn(GATES, gateName)) {
    workspaceFail(WORKSPACE_EXIT_USAGE, `unknown gate "${gateName}" — valid: ${Object.keys(GATES).join(', ')}`);
  }

  // `--step` is in this subcommand's value flags because `regress` and `census` forward it to their `prepare` child
  // (and `regressRunSide` calls this function in-process with the SAME gate name it gave its `evaluate` child). Until
  // now it was ACCEPTED AND NEVER READ here: an unrecognised step name was ignored by this command, preparation
  // continued, and the refusal that eventually arrived named something else entirely — which is how `E28-03` found
  // this row. The NAME is now checked against the resolved gate by the SAME `resolveStepFlag` every other command uses.
  //
  // What this does NOT do, and the difference matters: a step the judged commit does not declare is still UNDEFINED and
  // still proceeds. An unknown NAME is a typo; a declared step missing from an old commit is a finding, and the census
  // is built on that distinction.
  resolveStepFlag(flags, gateName);

  const commit = normalizeCommitSha(
    (git(['rev-parse', '--verify', `${requestedRef}^{commit}`], REPO_ROOT) ?? '').trim(),
  );

  if (commit === null) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `UNRESOLVABLE_COMMIT: "${requestedRef}" does not resolve to a commit in this repository — a run is refused, never evaluated at an unknown commit`,
    );
  }

  const resolution = resolveWorkspaceRoot();

  if (resolution === null) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      'NO_WORKTREE_ROOT: set HARNESS_WORKTREE_ROOT (or XDG_CACHE_HOME, or HOME). There is deliberately no repository-internal fallback — a root under the repository inherits its dependencies by upward resolution with zero setup.',
    );
  }

  // C1: refuse an in-repository root, a symlinked path component, and any ancestor that holds a `node_modules`.
  assertWorkspaceRootRefusals(resolution.path);

  const root = prepareControlRoot(resolution.path);
  const defaults = defaultEnvironmentInput().extra;
  const npmCache =
    typeof flags['npm-cache'] === 'string'
      ? resolve(flags['npm-cache'])
      : typeof process.env.HARNESS_NPM_CACHE === 'string' && process.env.HARNESS_NPM_CACHE.trim() !== ''
        ? resolve(process.env.HARNESS_NPM_CACHE)
        : null;
  // A5: the cache is a path input and gets the same placement refusal the worktree root gets, before anything is
  // spawned and before any directory is created.
  assertNpmCacheRefusal(npmCache);
  const extra = { ...defaults };

  if (offline) {
    extra.npm_config_offline = 'true';
  }

  if (npmCache !== null) {
    extra.npm_config_cache = npmCache;
  }

  const bundle = constructChildEnv({ extra, refuse: true, accepted: acceptedEnv });
  const childEnv = bundle.env;
  const platform = { os: process.platform, arch: process.arch };
  const packageManager = packageManagerRecord({
    version: probePackageManagerVersion(childEnv),
    declaredField: readHistoricalManifest(commit, 'package.json')?.packageManager,
  });

  // C8: both refusals happen BEFORE anything is spawned and before any directory is created.
  const lockfileRaw = gitShowBytes(commit, EVALUATIONS_LOCKFILE);
  const historical = assertHistoricalProject({
    commit,
    lockfileRaw,
    packageManager,
    acceptLockfileVersion: flags['accept-lockfile-version'] === true,
    acceptPmMismatch: flags['accept-pm-mismatch'] === true,
  });
  const lockfileDigest = lockfileRaw === null ? null : digest12(lockfileRaw);
  const npmrcDigest = effectiveNpmrcDigest(gitShowBytes(commit, '.npmrc'));
  const environmentNow = envFacts(childEnv, bundle);
  // The plan is derived BEFORE the key and before any worktree exists, from the judged commit's own manifests only.
  const buildMode = buildDisabled ? 'disabled' : declaredBuildRaw !== null ? 'declared' : 'derived';
  const buildPlan = buildMode === 'derived' ? historicalBuildPlanForCommit(commit) : null;

  // A7: an UNDETERMINED plan is refused, before a key is computed and before a worktree or an install exists. The
  // alternative — carrying on and letting the gate discover the missing output — is how a provisioning failure came
  // back as a `regression` / `test_failure` attributed to the commit, and how `build_state` came to say "no build
  // output is required by this gate" about a gate that required one.
  if (
    buildPlan !== null &&
    (buildPlan.build_plan_undetermined.length > 0 || buildPlan.build_plan_undetermined_patterns.length > 0)
  ) {
    // F2: the pattern cause is a SEPARATE clause with its own names and its own remedy, so a reader can tell "this
    // manifest's entrypoint is unreadable" from "this commit's workspace set is only partially known" — they were the
    // same verdict and they are not the same fact.
    const undeterminedEntrypoints = buildPlan.build_plan_undetermined.map(
      (entry) =>
        `${entry.dir ?? '.'} (${entry.name ?? 'unnamed'}) declares ${entry.fields.map((field) => `"${field.field}": ${JSON.stringify(field.value)}`).join(', ')}`,
    );
    const undeterminedPatterns = buildPlan.build_plan_undetermined_patterns.map(
      (entry) =>
        `workspaces pattern ${JSON.stringify(entry.pattern)} could not be enumerated as a literal relative directory (${entry.reason})`,
    );

    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `${BUILD_PLAN_UNDETERMINED_BASIS} Commit ${commit}: ${[...undeterminedEntrypoints, ...undeterminedPatterns].join('; ')}. Pass --build-command=<argv> to declare the build yourself, and the declared command bypasses this plan.`,
    );
  }

  const declaredBuildArgv = buildMode === 'declared' ? parseDeclaredBuildCommand(declaredBuildRaw) : null;
  const buildKey = {
    mode: buildMode,
    plan: buildPlan,
    plan_digest:
      buildMode === 'derived'
        ? buildPlan.digest
        : digest16(
            canonicalJson({
              mode: buildMode,
              command: declaredBuildArgv === null ? null : formatArgv(declaredBuildArgv),
            }),
          ),
    command: buildMode === 'declared' ? formatArgv(declaredBuildArgv) : null,
  };
  const key = computeWorkspaceKey({
    commit,
    lockfileDigest,
    nodeVersion: process.version,
    packageManager,
    platform,
    npmrcDigest,
    npmConfigDigest: environmentNow.allowlist_digest,
    fingerprintTier,
    // A2: the exclusion set is part of the digest's DEFINITION, so it is part of the reuse key.
    exclusionsVersion: INSTALLED_TREE_EXCLUSIONS.version,
    build: buildKey,
  });
  const directory = workspaceInstanceDirectory(root, key, instance);
  const deviation = installDeviation(flags, acceptedEnv, offline, npmCache, 'sanitised', buildMode);
  const reuse = verifyReusableWorkspace({
    attestation: readWorkspaceAttestation(key, instance),
    directory,
    commit,
    key,
    instance,
    fingerprintTier,
    build: buildKey,
    childEnv,
  });

  if (reuse.reusable) {
    printWorkspaceSummary([
      'workspace:              reused',
      `commit (requested):     ${requestedRef}`,
      `commit (resolved):      ${commit}`,
      `workspace_key:          ${key}`,
      `instance:               ${instance}`,
      `root:                   ${directory}`,
      `root source:            ${resolution.source}`,
      `reuse:                  re-verified — HEAD, node_modules topology, entry count, installed_state_digest, a fresh ${fingerprintTier}-tier walk of the installed tree AND ${
        reuse.buildState === null
          ? 'an empty build plan (no package needs building for this gate)'
          : 'a fresh walk of the build outputs the gate depends on'
      } all match the attestation`,
      `installed_state_digest: ${reuse.installed.state_digest} (${reuse.installed.state_digest_source} — declared by npm, NOT an observation of the bytes)`,
      `installed tree:         ${reuse.fingerprint.digest} (${fingerprintTier} tier, ${reuse.fingerprint.entries} entries walked by this program, exclusions: ${(reuse.fingerprint.exclusions ?? []).join(', ') || 'none'}) — ${reuse.fingerprint.limitation_with_exclusions}`,
      `build:                  ${buildMode}${buildPlan === null ? '' : ` (plan ${buildPlan.digest}, ${buildPlan.packages.length} package(s): ${buildPlan.packages.map((entry) => entry.name).join(', ') || 'none'})`}`,
      `build state:            ${reuse.buildState === null ? 'not applicable (an empty plan has no build output to observe)' : `${reuse.buildState.digest} (${reuse.buildState.regions.length} region(s) at the content tier, ${reuse.buildState.ignored.count} ignored path name(s) read) — ${reuse.buildState.limitation}`}`,
      `package manager:        ${packageManager.name} ${packageManager.version} (${packageManager.resolved_from})`,
      `node / platform:        ${process.version} · ${platform.os}/${platform.arch}`,
      'note:                   a worktree is not a security boundary, and a reusable attestation is local operator state, not evidence',
    ]);

    return 0;
  }

  if (existsSync(directory)) {
    // A directory that is already here was refused for reuse, and the reason is NAMED, so an operator reading only the
    // failure line can tell "there was nothing here" from "there was something here and it was not what it claimed". A
    // decoy `node_modules` in a pre-existing instance is therefore never handed back as `usable`: it is reclaimed and
    // rebuilt, or — when it is not a registered worktree of this repository and `--force` was not passed — REFUSED.
    const reclaimed = reclaimWorkspaceInstance({
      directory,
      root,
      // The path was DERIVED here, so the re-derivation is the same path by construction — the check is free and it
      // keeps one code path for every removal in this command.
      expectedDirectory: directory,
      force: flags.force === true,
    });

    if (!reclaimed.removed && reclaimed.reason !== 'absent') {
      workspaceFail(
        WORKSPACE_EXIT_USAGE,
        `RECLAIM_REFUSED: ${directory} — ${reclaimed.reason} (reuse was refused: ${reuse.reason}${
          reuse.detail === null ? '' : `; observed ${JSON.stringify(reuse.detail)}`
        }). A pre-existing directory is never reused as usable. What actually clears it: workspace remove --commit=<ref> [--instance=<label>] for a registered worktree of this repository, or --force on this command for a directory that is not one. Removing it by hand is not a supported path and leaves a git worktree admin record behind that wedges this instance.`,
      );
    }
  }

  // A3 — the recovery for a worktree directory that was removed OUT OF BAND. `git worktree add` then refuses with
  // "is a missing but already registered worktree; use 'add -f' … or 'prune' or 'remove' to clear", and because
  // `reclaimWorkspaceInstance` only pruned when the directory still resolved as a registered worktree — which is
  // false exactly in this state — `prepare`, `prepare --force` and `workspace remove` all failed forever with
  // WORKTREE_ADD_FAILED while the message kept advising "Remove it by hand or pass --force", neither of which works.
  // A crashed run or an operator `rm -rf` reaches this, so the wedge was reachable by accident.
  //
  // `git worktree prune` removes exactly the admin records whose directory is missing, which IS this state and nothing
  // else, so it is safe here and it is the documented recovery git itself names. Run BEFORE the add and again after a
  // failed add, so the instance recovers on its own with no hand-editing.
  gitWorktreePruneStaleRecord(directory);

  if (git(['worktree', 'add', '--detach', directory, commit]) === null) {
    // One retry: the only realistic cause is an admin record that appeared between the prune and the add.
    gitWorktreePruneStaleRecord(directory);

    if (git(['worktree', 'add', '--detach', directory, commit]) === null) {
      workspaceFail(
        WORKSPACE_EXIT_USAGE,
        `WORKTREE_ADD_FAILED: git worktree add --detach ${directory} ${commit} did not succeed, after pruning the stale worktree admin record for that path. If the path is occupied by something that is not a git worktree of this repository, remove it and re-run. If git reports it as a registered worktree of ANOTHER repository, only git worktree prune run in THAT repository can clear it.`,
      );
    }
  }

  // B4. THE RESERVATION. A `kill -9` between this `git worktree add` and the full `preparing` record used to leave a
  // worktree that NO shipped path could ever reach: the reclaim path is attestation-driven, `workspace list` reads only
  // attestations, and an interrupted prepare or regress has no attestation at all. Measured on a real `kill -9` mid
  // `--repeat=4`: 7 worktrees, 2 attestations, and `prune` reporting "every removal succeeded" over the 2 it could see
  // while 5 orphans stayed on disk forever.
  //
  // This record is written IMMEDIATELY, before the HEAD check and before the install, so the unattested window is the
  // single `git worktree add` call above and nothing else. It is a minimal, explicitly-staged reservation: it names the
  // directory, the key and the instance, and it says what stage it reached. It is not a `usable` attestation and reuse
  // never reads it as one.
  writeWorkspaceAttestation({
    schema_version: WORKSPACE_ATTESTATION_SCHEMA_VERSION,
    workspace_key: key,
    workspace_instance: instance,
    state: 'preparing',
    stage: 'worktree_created',
    reservation_written_at: new Date().toISOString(),
    preparing_written_at: new Date().toISOString(),
    judged_commit: commit,
    requested_ref: requestedRef,
    directory,
    gate: gateName,
    install: {
      mode: skipInstall ? 'none' : 'npm_ci',
      outcome: 'not_run',
      exit_code: null,
      duration_ms: null,
      offline,
      output_tail: null,
    },
    build_state: null,
    reservation_basis:
      'a directory now exists on disk under the workspace root. This record is written before anything is installed so that an interrupted prepare or regress leaves the directory REACHABLE by `workspace prune`; it asserts nothing about the dependencies, the build or the gate, and `reusable` is never true for it.',
    operator_state_note:
      'this file is operator state under .harness/state/, not evidence: it is not a ledger, enters no denominator and reads no decision path',
  });

  // The warning becomes a refusal: a prefix-tolerant check is exactly what let a stale directory pass silently.
  const head = normalizeCommitSha((git(['rev-parse', 'HEAD'], directory) ?? '').trim());

  if (head !== commit) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `HEAD_MISMATCH: the created worktree is at ${head ?? '(unreadable)'}, not the resolved ${commit}. Refusing rather than judging an unknown commit.`,
    );
  }

  // C1: the prepared directory must be a REGISTERED LINKED WORKTREE OF THIS REPOSITORY, decided by the same
  // `resolveJudgedScope` the evaluation record uses — never by a second, subtly different derivation.
  const judged = observeJudgedTree(directory);

  if (judged.scope !== 'linked_worktree_of_this_repo') {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `WORKTREE_SCOPE_REFUSED: ${directory} reports judged_commit_scope=${judged.scope ?? 'unresolved'}, not linked_worktree_of_this_repo`,
    );
  }

  const compatibility = gateCompatibility(gateName, { kind: 'workspace', path: directory });

  // PER-STEP COMPOSITION. `prepare` refuses a workspace whose WHOLE gate cannot resolve — correctly, for a whole-gate
  // run. With `--step=<name>` the question is narrower, and the whole-gate answer must not answer it: 86 of the 143
  // commits reachable from this repository's HEAD declare no `ui typecheck` script at all, so a per-step census of
  // `test:server` over that history would be refused for a script the named step never needed. The narrow check asks
  // the SAME question about the SAME manifests for the ONE step, and the whole-gate answer is still recorded — as a
  // disclosure on the attestation, not as a refusal.
  const prepareStep = resolveStepFlag(flags, gateName);
  const stepCompatibility = prepareStep === null ? null : resolveStepScope(gateName, prepareStep, directory);
  if (prepareStep === null && compatibility.problems.length > 0) {
    workspaceFail(
      WORKSPACE_EXIT_USAGE,
      `GATE_INCOMPATIBLE: gate "${gateName}" cannot run at ${commit}: ${compatibility.problems.join('; ')} — refused BEFORE any install is spent`,
    );
  }

  // An UNDEFINED step does NOT stop the preparation, and that is a deliberate single-owner decision rather than an
  // omission. Exactly ONE place turns `UNDEFINED` into a SIDE state, and it is `evaluate` — the only path that derives
  // one. Refusing here too would give the same situation two different refusals with two different words, and would make
  // the per-step record unreachable for exactly the commits a census needs it for (86 of 143 in this repository's own
  // history). The step's own answer travels on the attestation, and the workspace is prepared in full so the
  // environment observations exist either way.

  // C7: everything below is snapshotted, and the `preparing` attestation is written BEFORE the install is spawned, so
  // a killed or destructive install still leaves a durable trace of what was about to happen.
  const gitConfigBefore = observePrimaryGitConfig();
  const primaryModulesBefore = observePrimaryNodeModules();
  const observed = observeInstalledState(directory);
  const base = {
    schema_version: WORKSPACE_ATTESTATION_SCHEMA_VERSION,
    workspace_key: key,
    workspace_instance: instance,
    workspace_root_source: resolution.source,
    workspace_root_digest: digest16(resolution.path),
    judged_commit: commit,
    requested_ref: requestedRef,
    directory,
    gate: gateName,
    // PER-STEP COMPOSITION, recorded on the attestation so a reader of the WORKSPACE — not only of the run — can see
    // that this workspace was prepared for ONE named step, and which step that was. Additive and null on every
    // whole-gate preparation; a historical attestation without the field reads as "not recorded" exactly as before.
    step_scope:
      prepareStep === null
        ? null
        : {
            requested: prepareStep,
            gate: gateName,
            state: stepCompatibility.state,
            reason: stepCompatibility.reason,
            detail: stepCompatibility.detail,
            // Stated here rather than left to the reader: this records the APPLICABILITY answer, and `evaluate` is what
            // turns it into `UNDEFINED` as a side state. The two agree because they are the same question asked by the
            // same code against the same manifests.
            decided_by: 'the per-step evaluation run, not this attestation',
          },
    // The whole-gate answer is still recorded when it was NOT applied, so a reader never has to infer whether the
    // refusal happened. `null` on an ordinary whole-gate preparation, where it WAS applied (or there was nothing to apply).
    whole_gate_compatibility: prepareStep === null ? null : { problems: compatibility.problems, applied: false },
    lockfile_digest: lockfileDigest,
    lockfile_version: historical.lockfile_version,
    lockfile_version_supported: historical.lockfile_version_supported,
    npmrc_digest: npmrcDigest,
    // A6: the config FILES the install actually ran under, with the registry npm resolved. The digest above is one
    // opaque value in the reuse key; these name the paths and the answer, so a reader can see WHAT was in reach.
    npm_config_files: observeNpmConfigFiles(childEnv),
    package_manager: packageManager,
    node: observeNode(readHistoricalManifest(commit, 'package.json')),
    platform,
    env: environmentNow,
    // P0: the BUILD PLAN, recorded before anything is spawned, so the `preparing` record alone says what was about to
    // be executed. `null` for a declared command and for a disabled build, and `null` is normalised to the mode itself.
    historical_build_mode: buildMode,
    historical_build_plan_digest: buildKey.plan_digest,
    historical_build_plan: buildPlan,
    historical_build_command: buildKey.command,
    build_state: null,
    build_state_basis:
      buildMode === 'disabled'
        ? 'not applicable: the build step was disabled (--no-build)'
        : buildPlan === null
          ? 'not applicable: the operator declared the build command (--build-command), so the plan is whatever that command produces'
          : buildPlan.packages.length === 0
            ? BUILD_STATE_NOT_APPLICABLE_BASIS
            : 'not yet observed: the build has not run',
    deviation,
    operator_state_note:
      'this file is operator state under .harness/state/, not evidence: it is not a ledger, enters no denominator and reads no decision path',
  };
  const preparing = {
    ...base,
    state: 'preparing',
    stage: 'preparing_install_pending',
    preparing_written_at: new Date().toISOString(),
    install_started_at: null,
    install: {
      mode: skipInstall ? 'none' : 'npm_ci',
      outcome: 'not_run',
      exit_code: null,
      duration_ms: null,
      offline,
      output_tail: null,
    },
    installed_package_count: observed.entry_count,
    installed_state_digest: observed.state_digest,
    node_modules_topology: observed.topology,
    node_modules_scope: observed.scope,
    primary_git_config_hooks_path_before: gitConfigBefore.core_hooks_path,
  };

  writeWorkspaceAttestation(preparing);

  const removed = removeWorkspaceDependencies(directory);

  let install = preparing.install;
  let installStartedAt = null;

  if (!skipInstall) {
    installStartedAt = new Date().toISOString();
    const installStartedMs = Date.now();

    // The `preparing` record carries the install start, so the ORDER is provable from the durable record alone.
    writeWorkspaceAttestation({ ...preparing, install_started_at: installStartedAt });

    const result = spawnSync('npm', ['ci', ...(offline ? ['--offline'] : [])], {
      cwd: directory,
      encoding: 'utf8',
      env: childEnv,
    });
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    install = {
      mode: 'npm_ci',
      outcome: result.status === 0 ? 'succeeded' : 'failed',
      exit_code: Number.isInteger(result.status) ? result.status : null,
      duration_ms: Date.now() - installStartedMs,
      offline,
      output_tail: tailLines(combined, OUTPUT_TAIL_LINES, OUTPUT_TAIL_MAX_CHARS) || null,
    };
  }

  // P0: the build, AFTER the install and BEFORE any validation, under the same constructed child environment. Its
  // outcome is recorded with the install's own shape, and a failure becomes an `unusable` attestation with exit 5
  // rather than a "usable" workspace whose gate is doomed for a reason no field recorded.
  const build = runHistoricalBuild({
    directory,
    childEnv,
    plan: buildPlan ?? { packages: [] },
    mode: buildMode,
    declaredArgv: declaredBuildArgv ?? [],
  });

  // Never `true`. The policy is recorded; the execution of historical code is not observable from here.
  const buildScriptFacts =
    buildMode === 'disabled'
      ? {
          executed: null,
          basis: 'not applicable: no build ran (--no-build), so no build string could have been executed by this step',
          policy: 'not_applicable',
        }
      : {
          executed: null,
          basis: BUILD_SCRIPT_EXECUTION_BASIS,
          policy: 'historical_build_string_invoked_with_no_neutraliser',
        };

  const buildState =
    buildMode === 'derived' && buildPlan.packages.length > 0 ? observeBuildState(directory, buildPlan, childEnv) : null;

  const gitConfigAfter = observePrimaryGitConfig();
  const primaryModulesAfter = observePrimaryNodeModules();
  const installedAfter = observeInstalledState(directory);
  const provisioning = classifyProvisioning(installedAfter, install.outcome);
  const probe = observeResolverProbe(directory, childEnv);
  const probeFacts = classifyResolverProbe(probe, directory);
  // F4: the sentinel is probed under the SAME child environment the install and the gate get, so an accepted
  // `NODE_PATH` is OBSERVED here rather than merely disclosed in a deviation sentence.
  const negativeControl = observeResolverNegativeControl(directory, childEnv);
  const fingerprint = observeInstalledTreeFingerprint(directory, fingerprintTier);
  const scriptFacts = historicalInstallScriptFacts({
    skipInstall,
    ignoreScripts: flags['ignore-scripts'] === true,
    outputTail: install.output_tail,
  });
  const problems = [];

  if (installedAfter.topology === 'symlink') {
    problems.push('node_modules is a symlink');
  }

  if (installedAfter.scope === 'escapes_worktree') {
    problems.push('node_modules resolves outside the worktree root');
  }

  if (installedAfter.state_digest === null) {
    problems.push('npm wrote no node_modules/.package-lock.json — nothing records what was installed');
  }

  // FAIL CLOSED, on the fresh tree as well as on reuse: an install whose bytes cannot be walked is not an installed
  // tree this program can attest to, and there is deliberately no fallback to the cheaper walk.
  if (fingerprint === null) {
    problems.push(
      `the installed tree could not be walked at the ${fingerprintTier} tier, so its bytes are NOT attested — an unreadable file, a missing node_modules, or an unrecognised tier. There is no fallback to a weaker walk.`,
    );
  }

  // P0, the build's own problems, in the same vocabulary the other checks use and never merged with them.
  if (build.outcome === 'failed') {
    problems.push(
      `the historical build FAILED (${build.command ?? 'no command recorded'}; exit ${build.exit_code ?? 'n/a'}) — a build that cannot complete is a pre-evaluation environment failure, not a gate result`,
    );
  }

  if (build.outcome === 'unavailable') {
    problems.push(`the historical build could not be run: ${build.command_basis}`);
  }

  if (buildState !== null && buildState.observed !== true) {
    problems.push(
      `the build state could not be OBSERVED after the historical build (${build.outcome}): ${buildState.basis}${
        buildState.missing_outputs.length > 0 ? `; absent build outputs: ${buildState.missing_outputs.join(', ')}` : ''
      }${
        buildState.unwalkable_outputs.length > 0
          ? `; unwalkable build outputs: ${buildState.unwalkable_outputs.join(', ')}`
          : ''
      }`,
    );
  }

  // F3: two distinct reasons, each failing on its own terms. A `null` resolution is "absent", never "escaped".
  problems.push(...resolverProbeProblems(probeFacts));

  // F4: a control that resolves means something outside the workspace supplied a name the commit never declared.
  if (negativeControl.observed === true && negativeControl.resolved !== null) {
    problems.push(
      `the resolver NEGATIVE CONTROL "${negativeControl.name}" RESOLVED to ${negativeControl.resolved} — a package that is not a declared dependency of the judged commit is loadable, which an accepted NODE_PATH (or any other search path) can do invisibly to the declared-name probe`,
    );
  }

  if (!existsSync(join(directory, EVALUATIONS_LOCKFILE))) {
    problems.push('the historical lockfile disappeared from the worktree');
  }

  if (detectPrimaryCheckoutChange(gitConfigBefore, gitConfigAfter)) {
    problems.push(
      `<REPO_ROOT>/.git/config changed during the install (core.hooksPath ${gitConfigBefore.core_hooks_path ?? '(unset)'} -> ${gitConfigAfter.core_hooks_path ?? '(unset)'})`,
    );
  }

  if (primaryModulesBefore.digest !== null && primaryModulesAfter.digest !== primaryModulesBefore.digest) {
    problems.push("the PRIMARY checkout's node_modules changed during the install");
  }

  const usable = problems.length === 0;

  writeWorkspaceAttestation({
    ...base,
    state: usable ? 'usable' : 'unusable',
    preparing_written_at: preparing.preparing_written_at,
    install_started_at: installStartedAt,
    install,
    validation: { outcome: usable ? 'validated' : 'validation_failed', problems },
    usable_written_at: new Date().toISOString(),
    installed_package_count: installedAfter.entry_count,
    // The raw count and the names the exclusion removed, so the two counts can always be reconciled by a reader.
    installed_entry_count_raw: installedAfter.entry_count_raw,
    installed_entry_count_excluded: installedAfter.entry_count_excluded,
    // npm's own ACCOUNT of the tree, kept under its own name and its own label. It is not, and is never described as,
    // an observation of the bytes; the walk below is.
    installed_state_digest: installedAfter.state_digest,
    installed_state_digest_source: installedAfter.state_digest_source,
    // The observation THIS program makes. A separate, differently-named, differently-labelled field on purpose.
    installed_tree_fingerprint: fingerprint?.digest ?? null,
    installed_tree_fingerprint_tier: fingerprint === null ? null : fingerprint.tier,
    installed_tree_fingerprint_entries: fingerprint?.entries ?? null,
    // A3: the PRE-EXCLUSION count beside the post-exclusion one, so "every byte under those paths is UNATTESTED" is
    // a MAGNITUDE. The reconciliation is exact and checkable: entries_raw - entries === excluded_entries, and a
    // bounded count is recorded as bounded rather than presented as a complete one.
    installed_tree_fingerprint_entries_raw: fingerprint?.entries_raw ?? null,
    installed_tree_fingerprint_excluded_entries: fingerprint?.excluded_entries ?? null,
    installed_tree_fingerprint_excluded_entries_bounded: fingerprint?.excluded_entries_bounded ?? null,
    installed_tree_fingerprint_limitation: fingerprint === null ? null : fingerprint.limitation_with_exclusions,
    installed_tree_fingerprint_basis: TREE_FINGERPRINT_STANDING_LIMIT,
    installed_tree_fingerprint_verify: fingerprintTier,
    // The EXCLUSION set, recorded next to the digest it qualifies. A digest whose definition omits some bytes is not
    // readable without the set, and a silent exclusion would be a content-pin claim this program cannot support.
    installed_tree_fingerprint_exclusions:
      fingerprint === null ? [...INSTALLED_TREE_EXCLUSIONS.paths] : fingerprint.exclusions,
    installed_tree_fingerprint_exclusions_version: INSTALLED_TREE_EXCLUSIONS.version,
    installed_tree_fingerprint_excluded_paths: fingerprint === null ? [] : fingerprint.excluded_paths,
    node_modules_topology: installedAfter.topology,
    node_modules_scope: installedAfter.scope,
    dependency_provisioning: provisioning.value,
    dependency_provisioning_basis: provisioning.basis,
    resolver_probe: probe,
    resolver_probe_all_inside_workspace: probeFacts.all_inside_workspace,
    resolver_probe_resolved_outside: probeFacts.resolved_outside,
    resolver_probe_resolved_nothing: probeFacts.resolved_nothing,
    resolver_probe_negative_control: negativeControl,
    removed_before_install: removed,
    // C7 / F5: the BEFORE half rides in the final attestation, so the before/after pair is durably readable from one
    // record instead of requiring the transient `preparing` record to still exist.
    primary_git_config_hooks_path_before: gitConfigBefore.core_hooks_path,
    primary_git_config_hooks_path_after: gitConfigAfter.core_hooks_path,
    primary_git_config_changed: detectPrimaryCheckoutChange(gitConfigBefore, gitConfigAfter),
    primary_node_modules_unchanged:
      primaryModulesBefore.digest === null ? null : primaryModulesBefore.digest === primaryModulesAfter.digest,
    // F2: never `true`. The policy this program applied is recorded; whether a lifecycle script ran is not observable.
    historical_install_executed_arbitrary_scripts: scriptFacts.executed,
    historical_install_script_execution_basis: scriptFacts.basis,
    historical_install_scripts_policy: scriptFacts.policy,
    historical_install_ignore_scripts: scriptFacts.ignore_scripts,
    historical_install_output_showed_script_output: scriptFacts.output_showed_script_output,
    historical_install_output_basis: scriptFacts.basis_output,
    // P0: the BUILD, in full. Read from the judged commit's own manifests, executed in the worktree under the same
    // constructed environment as the install, with the same shape of recorded outcome the install has.
    historical_build_command: build.command,
    historical_build_command_basis: build.command_basis,
    historical_build_outcome: build.outcome,
    historical_build_exit_code: build.exit_code,
    historical_build_duration_ms: build.duration_ms,
    historical_build_output_tail: build.output_tail,
    historical_build_packages: build.packages,
    historical_build_started_at: build.started_at,
    historical_build_finished_at: build.finished_at,
    // Never `true`, for the same reason and with more force: a build executes the commit's own `build` string and has
    // no neutraliser at all.
    historical_build_executed_arbitrary_scripts: buildScriptFacts.executed,
    historical_build_script_execution_basis: buildScriptFacts.basis,
    historical_build_scripts_policy: buildScriptFacts.policy,
    // A8: what the build did OUTSIDE the worktree, bounded, with the class this program does NOT observe named in the
    // same record. A worktree is not a security boundary and this is a detection/observability limit, not prevention.
    historical_build_outside_worktree_writes: build.outside_worktree_writes,
    // P0: the BUILD STATE — the bytes the gate depends on, in the SOURCE tree, which every other fingerprint missed.
    build_state: buildState,
  });

  const header = [
    `commit (requested):     ${requestedRef}`,
    `commit (resolved):      ${commit}`,
    `workspace_key:          ${key}`,
    `instance:               ${instance}`,
    `root:                   ${directory}`,
    `root source:            ${resolution.source}`,
  ];

  if (!usable) {
    const reclaimed = keep
      ? { removed: false, bytes: 0, reason: 'retained_by_flag' }
      : // The install-failure cleanup reclaims the directory it just created, so an unusable instance leaves no
        // worktree behind. `root` and `expectedDirectory` are the derived values, so containment holds by construction.
        reclaimWorkspaceInstance({ directory, root, expectedDirectory: directory, force: true });

    printWorkspaceSummary([
      `workspace:              unusable (install ${install.outcome}, build ${build.outcome})${keep ? ' — retained for inspection (--keep)' : ''}`,
      ...header,
      'validation problems:',
      ...problems.map((problem) => `  - ${problem}`),
      `install exit code:      ${install.exit_code ?? 'n/a'}`,
      `build command:          ${build.command ?? '(none)'} (${buildMode})`,
      `build exit code:        ${build.exit_code ?? 'n/a'}`,
      reclaimed.removed
        ? `reclaimed:              ${formatBytes(reclaimed.bytes)} (pass --keep to retain it for inspection)`
        : `reclaim:                not removed (${reclaimed.reason})`,
      'note:                   an install failure is a PRE-EVALUATION event: no run, no evaluations[] entry, no verification[] entry, no ledger status',
    ]);

    return WORKSPACE_EXIT_ENVIRONMENT;
  }

  printWorkspaceSummary([
    'workspace:              usable',
    ...header,
    `dependency provisioning: ${provisioning.value} (${provisioning.basis}; ${installedAfter.topology}, ${installedAfter.scope})`,
    `install:                ${install.mode} -> ${install.outcome}${install.exit_code === null ? '' : ` (exit ${install.exit_code})`}${install.duration_ms === null ? '' : `, ${install.duration_ms} ms`}`,
    `installed entries:      ${installedAfter.entry_count ?? 'n/a'}`,
    `installed_state_digest: ${installedAfter.state_digest ?? 'n/a'} (${installedAfter.state_digest_source ?? 'no record'} — declared by npm, not an independent observation of the bytes)`,
    `installed tree:         ${fingerprint?.digest ?? 'UNAVAILABLE'} (${fingerprintTier} tier, ${fingerprint?.entries ?? 'n/a'} entries walked by this program, exclusions: ${(fingerprint?.exclusions ?? []).join(', ') || 'none'}) — ${fingerprint?.limitation_with_exclusions ?? 'no walk was possible, so the bytes are NOT attested'}`,
    `build:                  ${buildMode} -> ${build.outcome}${build.exit_code === null ? '' : ` (exit ${build.exit_code})`}${build.duration_ms === null ? '' : `, ${build.duration_ms} ms`}`,
    `build command:          ${build.command ?? '(none — nothing needed building for this gate)'} — ${build.command_basis}`,
    `build plan:             ${buildPlan === null ? '(not derived: the build command was declared or disabled)' : `${buildPlan.digest}; ${buildPlan.packages.length} package(s) to build: ${buildPlan.packages.map((entry) => `${entry.name} -> npm run build --workspace=${entry.name}`).join(', ') || 'none'}; ${buildPlan.packages_skipped.length} skipped`}`,
    `build scripts:          executed=${String(buildScriptFacts.executed)} (${buildScriptFacts.policy}) — a build EXECUTES the historical commit's own build string and has no neutraliser`,
    `build outside worktree:  ${build.outside_worktree_writes.outside_worktree_write_detected === null ? 'not applicable (no build ran)' : build.outside_worktree_writes.outside_worktree_write_detected ? `a top-level name CHANGED in: ${build.outside_worktree_writes.changed_roots.join(', ')}` : 'no top-level name changed in the three probed roots'} — ${build.outside_worktree_writes.unobserved_class}`,
    `build state:            ${buildState === null ? 'not applicable (no build output is required by this gate)' : `${buildState.observed ? buildState.digest : 'UNOBSERVED'} (${buildState.regions.length} declared build-output region(s) at the content tier, ${buildState.ignored.count ?? 'n/a'} ignored path name(s)) — ${buildState.limitation}`}`,
    `resolver probe:         ${probe.length === 0 ? '(no dependencies to probe)' : `${probe.length} probed, all resolved inside the worktree`} (resolved nothing: ${probeFacts.resolved_nothing.length}; resolved outside: ${probeFacts.resolved_outside.length})`,
    `negative control:       ${negativeControl.observed === false ? 'not observed' : negativeControl.resolved === null ? `${negativeControl.name} resolved to nothing, as it must` : `${negativeControl.name} RESOLVED to ${negativeControl.resolved} — an undeclared package is loadable`}`,
    `install scripts:        executed=${String(scriptFacts.executed)} (${scriptFacts.policy}); ignore-scripts=${String(scriptFacts.ignore_scripts)}; script-shaped output=${String(scriptFacts.output_showed_script_output)} — npm does not report whether a lifecycle script ran`,
    `package manager:        ${packageManager.name ?? '?'} ${packageManager.version ?? '?'} (${packageManager.resolved_from ?? 'unresolved'}; declared packageManager field: ${packageManager.declared_field ?? 'absent'})`,
    `node / platform:        ${process.version} · ${platform.os}/${platform.arch}`,
    `env:                    ${environmentNow.count} vars, digest ${environmentNow.vars_digest} (values are never recorded)`,
    `reclaim:                node .harness/runtime/harness.mjs workspace remove --commit=${commit} --instance=${instance}`,
    "note:                   a correct install under THIS npm is not the tree the commit's own npm would have produced, and no historical Node is installed here",
  ]);

  return 0;
}

function workspaceInstanceEntries(commit, instance) {
  return listWorkspaceAttestations().filter(
    (entry) => entry.judged_commit === commit && entry.workspace_instance === instance,
  );
}

function cmdWorkspaceRemove(flags) {
  const commit = typeof flags.commit === 'string' ? flags.commit.trim() : null;

  if (commit === null || commit === '') {
    workspaceFail(WORKSPACE_EXIT_USAGE, 'workspace remove requires --commit=<ref>');
  }

  const instance = workspaceInstance(flags);
  const entries = workspaceInstanceEntries(normalizeCommitSha(commit) ?? commit, instance);

  if (entries.length === 0) {
    process.stdout.write(`no workspace attestation for ${commit} (instance ${instance})\n`);

    return 0;
  }

  // A2: the root every removal must be inside, resolved the same way `prepare` resolves it and created if absent, so
  // the re-derived path below is the only path a recorded `directory` field is ever compared against.
  const removalRoot = prepareControlRoot(resolveWorkspaceRoot()?.path ?? '.');

  const lines = [];
  let failed = 0;

  for (const entry of entries) {
    const result = reclaimWorkspaceInstance({
      directory: entry.directory,
      root: removalRoot,
      // A2: re-derived from the key and instance, so the recorded `directory` is cross-checked, never obeyed.
      expectedDirectory: workspaceInstanceDirectory(removalRoot, entry.workspace_key, entry.workspace_instance),
      force: flags.force === true,
    });

    if (result.removed || result.reason === 'absent') {
      unlinkSync(workspaceAttestationPath(entry.workspace_key, entry.workspace_instance));
      lines.push(
        `removed:  ${entry.directory} (was at ${entry.judged_commit}) — reclaimed ${formatBytes(result.bytes)}`,
      );
    } else {
      failed += 1;
      lines.push(`FAILED:   ${entry.directory} — ${result.reason}`);
    }
  }

  printWorkspaceSummary(lines);

  return failed === 0 ? 0 : 1;
}

/**
 * B4. THE DIRECTORY SCAN. Attestation-driven reclaim can only reclaim what an attestation names, so it is structurally
 * blind to a worktree whose prepare was interrupted before any attestation existed. This walk closes that: it reads the
 * workspace root's own layout (`<root>/<16-hex key>/<bounded instance>`) and reports every directory that has no
 * attestation behind it. It OPENS NO FILE inside those directories — it compares NAMES, which is the same observation
 * `build_state.ignored` makes and the same discipline the rest of this program follows.
 *
 * The point is not primarily to reclaim. The point is that "considered: 0, every removal succeeded" must never again be
 * able to mean "there are 5 orphans I cannot see": the report now distinguishes NOTHING TO RECLAIM from ORPHANS EXIST.
 */
const WORKSPACE_ORPHAN_SCAN_BASIS =
  'a directory-scan reclaim: the workspace root is walked for <key>/<instance> directories and compared by NAME against the attestation set, and the <key> level itself is classified. It opens no file inside an orphan, and it is bounded to the two-level layout this program itself creates. Without it, prune is attestation-driven only and an interrupted prepare or regress leaves a worktree that no shipped path can reach and no report can see. The <key> level is scanned because a SIGKILL in the EARLIEST window (after the key directory is created, before the instance directory is) leaves an EMPTY <key> directory holding no instance at all, which the <key>/<instance> walk cannot match: prune then reported "orphans detected: 0" and printed NOTHING_TO_RECLAIM — a sentence that was FALSE in exactly the state these directories exist in, and a false sentence in a durable record is the class of wrong this harness exists to prevent. Such a directory is reported as `empty_key`, and reclaimed only with --force and only while it is still empty; a <key> directory holding anything this program does not recognise is reported as `unrecognised_key` and is NEVER removed.';

function scanWorkspaceOrphans(root, attestedDirectories) {
  if (!existsSync(root)) {
    return {
      scanned: false,
      root,
      orphans: [],
      // Additive, and always present: a scan that could not run accounts for nothing it could not see, and the caller
      // says so rather than reading an absent field as "none were there".
      empty_keys: [],
      unrecognised_keys: [],
      unaccounted: 0,
      reason: 'the workspace root does not exist',
      basis: WORKSPACE_ORPHAN_SCAN_BASIS,
    };
  }

  const attested = new Set(attestedDirectories);
  const orphans = [];
  const emptyKeys = [];
  const unrecognisedKeys = [];
  let readable = true;

  for (const key of readdirSync(root).sort()) {
    if (!DIGEST_16_RE.test(key)) {
      continue;
    }

    const keyDirectory = join(root, key);

    if (!lstatSync(keyDirectory).isDirectory()) {
      continue;
    }

    const entries = readdirSync(keyDirectory).sort();
    const instances = entries.filter((entry) => WORKSPACE_INSTANCE_RE.test(entry));

    // F3 (B4 residual). A <key> directory with no instance subdirectory is a state this program creates and the
    // <key>/<instance> walk below is structurally unable to see. It is classified here so that "no unattested directory
    // exists under the workspace root" can never be printed while one does.
    if (instances.length === 0) {
      if (entries.length === 0) {
        emptyKeys.push({ workspace_key: key, directory: keyDirectory, entries: 0 });
      } else {
        // Never reclaimed: the contents are not a layout this program created, and this scan does not open them to
        // decide what they are.
        unrecognisedKeys.push({ workspace_key: key, directory: keyDirectory, entry_names: entries.slice(0, 20) });
      }
    }

    for (const instance of instances) {
      const directory = workspaceInstanceDirectory(root, key, instance);

      if (attested.has(directory) || !existsSync(directory)) {
        continue;
      }

      orphans.push({ workspace_key: key, workspace_instance: instance, directory });
    }
  }

  return {
    scanned: readable,
    root,
    orphans,
    empty_keys: emptyKeys,
    unrecognised_keys: unrecognisedKeys,
    // ONE number the `scope` sentence is derived from, so the sentence has a single source of truth to be wrong about.
    unaccounted: orphans.length + emptyKeys.length + unrecognisedKeys.length,
    reason: readable ? null : 'the workspace root could not be read',
    basis: WORKSPACE_ORPHAN_SCAN_BASIS,
  };
}

/**
 * F3. Remove an EMPTY `<key>` directory, and only that.
 *
 * The safety argument is the emptiness, not the `--force`: an empty directory cannot contain a worktree, an
 * attestation, or anything else, so removing it can destroy no evidence. The emptiness is therefore RE-CHECKED here
 * rather than trusted from the scan, so a directory that acquired contents between the scan and this call is refused
 * instead of removed. `rmdir` on a non-empty directory fails natively, which is the same rule enforced by the platform.
 */
function reclaimEmptyWorkspaceKey({ directory, root = null, force = false }) {
  if (root === null) {
    return { removed: false, bytes: 0, reason: 'no_worktree_root_supplied' };
  }

  const resolvedRoot = safeRealpath(root);

  if (resolvedRoot === null) {
    return { removed: false, bytes: 0, reason: 'worktree_root_unresolvable' };
  }

  if (!existsSync(directory)) {
    return { removed: false, bytes: 0, reason: 'absent' };
  }

  const real = safeRealpath(directory);

  // Containment is never waived, exactly as for an instance directory.
  if (real === null || !isContainedBy(real, resolvedRoot)) {
    return { removed: false, bytes: 0, reason: 'not_contained_by_worktree_root' };
  }

  // Re-observed here, never believed from the scan.
  let entries;

  try {
    entries = readdirSync(directory);
  } catch {
    return { removed: false, bytes: 0, reason: 'unreadable' };
  }

  if (entries.length > 0) {
    return { removed: false, bytes: 0, reason: 'not_empty' };
  }

  if (!force) {
    return { removed: false, bytes: 0, reason: 'force_required' };
  }

  try {
    rmdirSync(directory);
  } catch {
    return { removed: false, bytes: 0, reason: 'rmdir_failed' };
  }

  return { removed: !existsSync(directory), bytes: 0, reason: existsSync(directory) ? 'rmdir_incomplete' : 'removed' };
}

function cmdWorkspacePrune(flags) {
  const staleAfterMs = parseDurationMs(flags['stale-after'], 3_600_000);

  if (staleAfterMs === null) {
    workspaceFail(WORKSPACE_EXIT_USAGE, '--stale-after must be a duration like 30m, 2h or 7d');
  }

  const now = Date.now();
  const lines = [];
  let failed = 0;
  let reclaimed = 0;
  let considered = 0;
  // A2: the root every removal must be inside. Resolved and created exactly as `prepare` does it, so the path
  // re-derived from each attestation's key and instance is the ONLY comparison the recorded `directory` is held to.
  const removalRoot = prepareControlRoot(resolveWorkspaceRoot()?.path ?? '.');

  for (const entry of listWorkspaceAttestations()) {
    const stamp = Date.parse(entry.usable_written_at ?? entry.preparing_written_at ?? '');

    if (!Number.isFinite(stamp) || now - stamp < staleAfterMs) {
      continue;
    }

    considered += 1;

    const result = reclaimWorkspaceInstance({
      directory: entry.directory,
      root: removalRoot,
      // A2: re-derived from the key and instance, so the recorded `directory` is cross-checked, never obeyed.
      expectedDirectory: workspaceInstanceDirectory(removalRoot, entry.workspace_key, entry.workspace_instance),
      force: flags.force === true,
    });

    if (result.removed || result.reason === 'absent') {
      reclaimed += result.bytes;
      unlinkSync(workspaceAttestationPath(entry.workspace_key, entry.workspace_instance));
      lines.push(
        `pruned:  ${entry.directory} (${entry.state ?? 'unknown'}, at ${(entry.judged_commit ?? '?').slice(0, 12)}) — ${formatBytes(result.bytes)}`,
      );
    } else {
      failed += 1;
      lines.push(`FAILED:   ${entry.directory} — ${result.reason}`);
    }
  }

  // B4. The scan runs AFTER the attestation-driven pass, so an attested directory that was just reclaimed is not then
  // reported as an orphan of its own removal.
  const attestedDirectories = new Map();

  for (const entry of listWorkspaceAttestations()) {
    if (typeof entry.workspace_key === 'string' && typeof entry.workspace_instance === 'string') {
      attestedDirectories.set(
        workspaceInstanceDirectory(removalRoot, entry.workspace_key, entry.workspace_instance),
        entry,
      );
    }
  }

  const scan = scanWorkspaceOrphans(removalRoot, attestedDirectories);
  const orphanLines = [];
  const keyOnlyLines = [];
  let orphanReclaimed = 0;
  let orphanFailed = 0;
  let keyOnlyReclaimed = 0;
  let keyOnlyFailed = 0;

  for (const orphan of scan.orphans) {
    const result = reclaimWorkspaceInstance({
      directory: orphan.directory,
      root: removalRoot,
      // Re-derived from the names just scanned, never from anything an orphan could name about itself.
      expectedDirectory: workspaceInstanceDirectory(removalRoot, orphan.workspace_key, orphan.workspace_instance),
      // An orphan is reclaimed only on an explicit --force: it has no attestation, so nothing asserts it is stale.
      force: flags.force === true,
    });

    if (result.removed || result.reason === 'absent') {
      orphanReclaimed += result.bytes;
      reclaimed += result.bytes;
      orphanLines.push(
        `orphan:   ${orphan.directory} — UNATTESTED on disk (key ${orphan.workspace_key}, instance ${orphan.workspace_instance}); reclaimed ${formatBytes(result.bytes)}`,
      );
    } else if (flags.force === true) {
      orphanFailed += 1;
      orphanLines.push(`FAILED:   ${orphan.directory} — ${result.reason}`);
    } else {
      // Reported, never reclaimed, and never counted as a success: this is the line that keeps the gap from being silent.
      orphanLines.push(
        `ORPHAN:   ${orphan.directory} — UNATTESTED on disk and NOT reclaimed; this directory exists, is invisible to the attestation-driven pass and was left by an interrupted prepare or regress. Reclaim it with: workspace prune --stale-after=1s --force`,
      );
    }
  }

  // F3. The <key>-ONLY state: a key directory this program created that holds no instance at all. It is scanned, it is
  // reported, and with --force it is removed — but only while it is still empty, which is re-observed at the moment of
  // removal rather than believed from the scan. It is NOT an orphan in the instance sense (it holds no worktree), so it
  // is counted and printed on its own lines and it participates in the `scope` sentence below.
  for (const empty of scan.empty_keys) {
    const result = reclaimEmptyWorkspaceKey({
      directory: empty.directory,
      root: removalRoot,
      force: flags.force === true,
    });

    if (result.removed || result.reason === 'absent') {
      keyOnlyReclaimed += 1;
      keyOnlyLines.push(
        `empty key: ${empty.directory} — <key> directory with no instance subdirectory (key ${empty.workspace_key}); reclaimed`,
      );
    } else if (result.reason === 'force_required') {
      keyOnlyLines.push(
        `EMPTY KEY: ${empty.directory} — <key> directory with no instance subdirectory (key ${empty.workspace_key}); left by a SIGKILL in the earliest window, holds no worktree, costs 0 bytes, and is NOT reclaimed without --force. Reclaim it with: workspace prune --stale-after=1s --force`,
      );
    } else {
      keyOnlyFailed += 1;
      keyOnlyLines.push(`FAILED:   ${empty.directory} — ${result.reason}`);
    }
  }

  // A <key> directory holding entries this program does not recognise is REPORTED and never removed: the scan does not
  // open them, so it cannot assert what they are.
  for (const unrecognised of scan.unrecognised_keys) {
    keyOnlyLines.push(
      `UNRECOGNISED KEY: ${unrecognised.directory} — a <key>-named directory holding ${unrecognised.entry_names.length} entr(ies) that are not instance directories (${unrecognised.entry_names.join(', ')}); reported and NEVER reclaimed, because the scan does not open them to decide what they are`,
    );
  }

  git(['worktree', 'prune']);

  // B4 + F3: the report says WHICH of the situations it is in, so "nothing to reclaim" can never be confused with
  // "directories exist that this command cannot see".
  //
  // The sentence is derived from TWO computed numbers and never from a remembered one. `unaccounted` is what the scan
  // SAW — orphans plus key-only plus unrecognised-key, the ONE number the scan computes, so the sentence has a single
  // source of truth for the scan. `remaining` is what is STILL THERE, observed after this run's removals rather than
  // inferred from them, and it is the number that decides the LABEL: a `RECLAIMED` line that did not reclaim anything,
  // or a `NOTHING_TO_RECLAIM` line while a directory still exists, would each be a false sentence in a durable record.
  // Deriving it from `scan.orphans.length` alone — as this did before F3 — was FALSE in exactly the state the key-only
  // directories exist in.
  const unaccounted = scan.unaccounted;
  const scannedDirectories = [
    ...scan.orphans.map((entry) => entry.directory),
    ...scan.empty_keys.map((entry) => entry.directory),
    ...scan.unrecognised_keys.map((entry) => entry.directory),
  ];
  const remaining = scannedDirectories.filter((directory) => existsSync(directory)).length;
  const scope =
    considered === 0 && unaccounted === 0
      ? 'NOTHING_TO_RECLAIM — no attestation was stale and no unattested directory exists under the workspace root'
      : remaining > 0
        ? `UNATTESTED_DIRECTORIES_EXIST — ${considered} attestation(s) considered, ${unaccounted} unattested director(ies) seen (${scan.orphans.length} instance, ${scan.empty_keys.length} empty <key>, ${scan.unrecognised_keys.length} unrecognised <key> scan basis unchanged); ${remaining} of them STILL EXIST on disk after this run and are reported, not removed`
        : `RECLAIMED — ${considered} attestation(s) considered, ${unaccounted} unattested director(ies) seen (${scan.orphans.length} instance, ${scan.empty_keys.length} empty <key>, ${scan.unrecognised_keys.length} unrecognised <key>) and NONE of them remains on disk; ${keyOnlyReclaimed} empty <key> director(ies) reclaimed`;

  printWorkspaceSummary([
    `stale after:            ${staleAfterMs} ms`,
    `considered:             ${considered}`,
    `reclaimed:              ${formatBytes(reclaimed)}`,
    ...lines,
    ...orphanLines,
    ...keyOnlyLines,
    `orphans detected:       ${scan.orphans.length} (directory scan of ${relative(scan.root)}; ${scan.orphans.length === 0 ? 'no <key>/<instance> directory was unattested' : 'an attestation-driven pass alone would never have seen these'})`,
    `key-only directories:   ${scan.empty_keys.length} empty <key>, ${scan.unrecognised_keys.length} unrecognised <key> (${keyOnlyReclaimed} reclaimed)`,
    `unaccounted seen:       ${unaccounted} (the single number the scan derives the scope sentence from)`,
    `unaccounted remaining:  ${remaining} (observed on disk AFTER this run's removals; the number that picks the scope label)`,
    `scan basis:             ${scan.basis}`,
    `scope:                  ${scope}`,
    // Cleanup failure now has an observable signal; it is not a success that silently did nothing. The claim is about the
    // removals this run ATTEMPTED, and the `scope` line above is what makes it safe: it says whether there was anything
    // the run could not see, which is the sentence that would otherwise be false.
    `result:                 ${failed === 0 && orphanFailed === 0 && keyOnlyFailed === 0 ? 'every removal succeeded' : `${failed + orphanFailed + keyOnlyFailed} removal(s) FAILED`}`,
  ]);

  return failed === 0 && orphanFailed === 0 && keyOnlyFailed === 0 ? 0 : 1;
}

function cmdWorkspaceShow(flags) {
  const commit = typeof flags.commit === 'string' ? flags.commit.trim() : null;
  const instance = workspaceInstance(flags);
  const entries =
    commit === null
      ? listWorkspaceAttestations().filter((entry) => entry.workspace_instance === instance)
      : workspaceInstanceEntries(normalizeCommitSha(commit) ?? commit, instance);

  if (entries.length === 0) {
    process.stdout.write(
      `no workspace attestation${commit === null ? '' : ` for ${commit}`} (instance ${instance}) — nothing has been prepared\n`,
    );

    return 0;
  }

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);

    return 0;
  }

  const lines = [];

  for (const entry of entries) {
    lines.push(
      '',
      `workspace_key:          ${entry.workspace_key}`,
      `instance:               ${entry.workspace_instance}`,
      `state:                  ${entry.state ?? 'unknown'} (${entry.validation?.outcome ?? 'n/a'})`,
      `commit (resolved):      ${entry.judged_commit ?? 'not recorded'} (requested: ${entry.requested_ref ?? 'n/a'})`,
      `directory:              ${entry.directory ?? 'not recorded'}`,
      `root source:            ${entry.workspace_root_source ?? 'n/a'} (digest ${entry.workspace_root_digest ?? 'n/a'})`,
      `dependency provisioning: ${entry.dependency_provisioning ?? 'n/a'} (${entry.dependency_provisioning_basis ?? 'n/a'}; ${entry.node_modules_topology ?? 'n/a'}, ${entry.node_modules_scope ?? 'n/a'})`,
      `install:                ${entry.install?.mode ?? 'n/a'} -> ${entry.install?.outcome ?? 'n/a'}${entry.install?.exit_code === null || entry.install?.exit_code === undefined ? '' : ` (exit ${entry.install.exit_code})`}`,
      `preparing written at:   ${entry.preparing_written_at ?? 'n/a'}`,
      `install started at:     ${entry.install_started_at ?? '(never started)'}`,
      `installed_state_digest: ${entry.installed_state_digest ?? 'n/a'} (${entry.installed_state_digest_source ?? 'no record'} — declared by npm)`,
      `installed tree:         ${entry.installed_tree_fingerprint ?? 'UNAVAILABLE'} (${entry.installed_tree_fingerprint_tier ?? 'no tier'} tier, ${entry.installed_tree_fingerprint_entries ?? 'n/a'} entries walked by this program)`,
      `  walk exclusions:     ${(entry.installed_tree_fingerprint_exclusions ?? []).join(', ') || 'none recorded'} (set version ${entry.installed_tree_fingerprint_exclusions_version ?? 'n/a'}; observed excluded: ${(entry.installed_tree_fingerprint_excluded_paths ?? []).join(', ') || 'none'})`,
      `  what it cannot see:  ${entry.installed_tree_fingerprint_limitation ?? 'no walk was recorded'}`,
      `build:                  ${entry.historical_build_mode ?? 'not recorded'} -> ${entry.historical_build_outcome ?? 'not recorded'}${entry.historical_build_exit_code === null || entry.historical_build_exit_code === undefined ? '' : ` (exit ${entry.historical_build_exit_code})`}${entry.historical_build_duration_ms === null || entry.historical_build_duration_ms === undefined ? '' : `, ${entry.historical_build_duration_ms} ms`}`,
      `build command:          ${entry.historical_build_command ?? '(none — nothing needed building for this gate)'} — ${entry.historical_build_command_basis ?? 'basis not recorded'}`,
      `build plan:             ${entry.historical_build_plan_digest ?? '(not derived: the build command was declared or disabled)'}${
        entry.historical_build_plan === undefined
          ? ''
          : `; ${(entry.historical_build_plan.packages ?? []).length} package(s) built, ${(entry.historical_build_plan.packages_skipped ?? []).length} skipped; rule: ${entry.historical_build_plan.selection_rule ?? 'not recorded'}`
      }`,
      `build scripts:          executed=${String(entry.historical_build_executed_arbitrary_scripts)} (${entry.historical_build_scripts_policy ?? 'not recorded'}) — ${entry.historical_build_script_execution_basis ?? 'basis not recorded'}`,
      `build state:            ${
        entry.build_state === undefined
          ? 'not recorded'
          : entry.build_state === null
            ? (entry.build_state_basis ?? 'not applicable')
            : `${entry.build_state.observed ? entry.build_state.digest : 'UNOBSERVED'} (${(entry.build_state.regions ?? []).length} build-output region(s) at the ${entry.build_state.tier ?? '?'} tier; ${entry.build_state.ignored?.count ?? 'n/a'} ignored path name(s) read by \`${entry.build_state.ignored?.command ?? 'git'}\`; regions: ${(entry.build_state.regions ?? []).map((region) => `${region.path}:${region.present ? region.digest : 'ABSENT'}`).join(', ') || 'none'})`
      }`,
      `  what it cannot see:  ${entry.build_state?.limitation ?? 'no build-state limitation recorded'}`,
      `resolver probe:         ${
        (entry.resolver_probe ?? []).length === 0
          ? '(none)'
          : entry.resolver_probe
              .map((probe) => `${probe.name} -> ${probe.resolved ?? 'unresolved (absent, NOT an escape)'}`)
              .join('; ')
      }`,
      `  resolved nothing:     ${(entry.resolver_probe_resolved_nothing ?? []).join(', ') || '(none)'}`,
      `  resolved outside:     ${(entry.resolver_probe_resolved_outside ?? []).join(', ') || '(none)'}`,
      `negative control:       ${entry.resolver_probe_negative_control === undefined ? 'not recorded' : `${entry.resolver_probe_negative_control.name} -> ${entry.resolver_probe_negative_control.resolved ?? 'nothing (as it must be)'}${entry.resolver_probe_negative_control.observed === false ? ' [NOT OBSERVED]' : ''}`}`,
      `install scripts:        executed=${String(entry.historical_install_executed_arbitrary_scripts)} (${entry.historical_install_scripts_policy ?? 'not recorded'}), ignore-scripts=${String(entry.historical_install_ignore_scripts)}, script-shaped output=${String(entry.historical_install_output_showed_script_output)} — ${entry.historical_install_script_execution_basis ?? 'basis not recorded'}`,
      `git config hooksPath:   ${entry.primary_git_config_hooks_path_before ?? '(unset)'} -> ${entry.primary_git_config_hooks_path_after ?? '(unset)'} (changed: ${String(entry.primary_git_config_changed ?? false)})`,
      `deviation:              ${entry.deviation ?? 'none'}`,
      ...(entry.validation?.problems ?? []).map((problem) => `  - ${problem}`),
      'note:                   a worktree is not a security boundary, and this record is not authenticity evidence',
    );
  }

  process.stdout.write(`${['', ...lines, ''].join('\n')}\n`);

  return 0;
}

function cmdWorkspaceList() {
  const entries = listWorkspaceAttestations();
  // B4. `workspace list` read only attestations, so it could not show a worktree left by an interrupted prepare. The
  // scan is reported here too, so the inventory a human reads is the inventory that exists on disk.
  const listingRoot = resolveWorkspaceRoot()?.path ?? null;
  const listingScan =
    listingRoot === null
      ? null
      : scanWorkspaceOrphans(
          listingRoot,
          new Set(
            entries
              .filter(
                (entry) => typeof entry.workspace_key === 'string' && typeof entry.workspace_instance === 'string',
              )
              .map((entry) => workspaceInstanceDirectory(listingRoot, entry.workspace_key, entry.workspace_instance)),
          ),
        );

  // F3: the "no prepared workspaces" line must not be printed while an unattested directory of ANY shape exists — the
  // <key>-only state is one this program creates and the inventory has to account for it too.
  if (entries.length === 0 && (listingScan === null || listingScan.unaccounted === 0)) {
    process.stdout.write(
      'no prepared workspaces — run: node .harness/runtime/harness.mjs workspace prepare --commit=<ref>\n',
    );

    return 0;
  }

  const header = ['key', 'instance', 'commit', 'state', 'install', 'pm', 'provisioning'];
  const rows = entries.map((entry) => [
    entry.workspace_key,
    entry.workspace_instance ?? '?',
    (entry.judged_commit ?? '?').slice(0, 12),
    entry.state ?? '?',
    entry.install?.outcome ?? 'n/a',
    `${entry.package_manager?.name ?? '?'} ${entry.package_manager?.version ?? '?'}`,
    entry.dependency_provisioning ?? 'n/a',
  ]);
  const width = (column) => Math.max(header[column].length, ...rows.map((row) => String(row[column]).length));
  const pad = (value, length) => String(value).padEnd(length);
  const orphans = listingScan === null ? [] : listingScan.orphans;
  const emptyKeys = listingScan === null ? [] : listingScan.empty_keys;
  const unrecognisedKeys = listingScan === null ? [] : listingScan.unrecognised_keys;
  const unaccounted = listingScan === null ? 0 : listingScan.unaccounted;

  printWorkspaceSummary([
    ...(entries.length === 0
      ? []
      : [
          [...header.map((label, column) => pad(label, width(column))), 'directory'].join('  '),
          ...rows.map((row, index) =>
            [...row.map((value, column) => pad(value, width(column))), entries[index].directory ?? 'n/a'].join('  '),
          ),
        ]),
    ...(orphans.length === 0
      ? []
      : [
          '',
          'unattested directories on disk (no attestation — an interrupted prepare or regress left these):',
          ...orphans.map((orphan) => `  ${orphan.workspace_key}  ${orphan.workspace_instance}  ${orphan.directory}`),
          `  reclaim with: workspace prune --stale-after=1s --force   (${WORKSPACE_ORPHAN_SCAN_BASIS})`,
        ]),
    ...(emptyKeys.length === 0
      ? []
      : [
          '',
          'empty <key> directories on disk (no instance subdirectory — a SIGKILL in the earliest window left these; they hold no worktree and cost 0 bytes):',
          ...emptyKeys.map((empty) => `  ${empty.workspace_key}  (no instance)  ${empty.directory}`),
          '  reclaim with: workspace prune --stale-after=1s --force',
        ]),
    ...(unrecognisedKeys.length === 0
      ? []
      : [
          '',
          'unrecognised <key> directories on disk (a <key>-named directory holding entries that are not instance directories; reported, NEVER reclaimed):',
          ...unrecognisedKeys.map(
            (entry) => `  ${entry.workspace_key}  ${entry.entry_names.join(', ')}  ${entry.directory}`,
          ),
        ]),
    '',
    `${entries.length} prepared workspace(s), ${unaccounted} unattested director(ies) on disk (${orphans.length} instance, ${emptyKeys.length} empty <key>, ${unrecognisedKeys.length} unrecognised <key>)`,
  ]);

  return 0;
}

// ---------------------------------------------------------------- regress (P3) and the four-state classification (P4)
//
// P4 — the four SIDE states. The boundaries are the whole point of this increment, so they are stated once, here, and
// every other surface (docs, artifact, exit codes) restates rather than redefines them:
//   PASS         the gate ran to completion, every step exited 0, and nothing made the outcome undecidable.
//   FAIL         the gate ran to completion and at least one step exited non-zero.
//   INCONCLUSIVE the side WAS measured, but the measurement cannot decide a verdict.
//   ERROR        a harness/operational failure: a command could not be run to completion.
// The one sentence that separates the last two: ERROR is a statement about the TOOL (something did not run), while
// INCONCLUSIVE is a statement about the EVALUATED STATE (the tool ran, and what it saw is not decisive). INCONCLUSIVE
// is neither good nor bad: it is never counted as a pass, never as a fail, and never resolved by preferring the side
// that happens to look better.
const REGRESS_SIDE_STATES = ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'];
const REGRESS_VERDICTS = ['no_regression', 'regression', 'already_failing', 'improved', 'cannot_compare'];
/**
 * `harness regress` publishes a COMMAND-LOCAL exit set. It never reinterprets, and is never reinterpreted as, the
 * evaluate protocol (`0 ⟺ verified`, `1`, `2`, `3`). `3` is deliberately never emitted here: it is evaluate's
 * `gate_incompatible`, and a comparison command that never runs a gate must not be able to produce it.
 */
const REGRESS_EXIT_NO_FINDING = 0;
const REGRESS_EXIT_FINDING = 1;
const REGRESS_EXIT_USAGE = 2;
const REGRESS_EXIT_SIDE_ERROR = 4;
const REGRESS_EXIT_INCONCLUSIVE = 5;
const REGRESS_EXIT_CLEANUP_FAILED = 6;
/**
 * F6. Exit `5` carries TWO distinct situations, and the printed label used to name only one of them.
 *
 * `AGENTS.md` and `.harness/README.md` document `regress` exit `5` as "a side is INCONCLUSIVE". The trial-log byte-bound
 * refusal also exits `5` and printed "5 (command-local environment failure)". Both readings were true at that site and
 * the two sentences contradicted each other in the reader's head — a printed label that disagrees with the manual is a
 * documentation-truth defect wearing a runtime costume.
 *
 * The fix is NOT a new exit code. The `regress` set is `0 1 2 4 5 6` with `3` never emitted, and `5` is already
 * documented as the undecidable outcome; minting a seventh code for a refusal that is also "no verdict was derived"
 * would widen a command-local protocol to fix a wording problem, and a wider protocol has more places to drift. Instead
 * the label names BOTH, and this string is the single definition the documentation repeats.
 *
 * The two situations are genuinely one exit code because they agree on everything a caller acts on: `verdict:
 * cannot_compare`, no direction, neither side named as the winner. They differ in WHY, and the line below prints the
 * reason as well as the number.
 */
const REGRESS_EXIT_FIVE_BASIS =
  'a side is INCONCLUSIVE, OR no verdict could be derived at all: 5 is the code for every regress outcome that must not name a direction. A side that was measured but undecidable reaches it (INCONCLUSIVE != PASS != FAIL), and so does a run refused before a verdict was derived — the trial-log byte bound, which is a command-local ENVIRONMENT failure, not a statement about either commit. The two agree on everything a caller acts on (verdict cannot_compare, no direction, no winner) and differ only in why, which the refusal line prints beside the number. It is never a finding, and it is never a red side.';
/**
 * EXIT PRECEDENCE, R4 — decided once, here, and stated in the human report and in the artifact every time it bites.
 *
 * A FINDING outranks a refused cleanup. A finding is a statement about the CODE (`a` passed, `b` failed); a refused
 * removal is a statement about a DIRECTORY this process tried to delete. Substituting the second for the first would
 * let a permission problem silently demote a real regression to an unremarkable operational code, which is the same
 * laundering the four-state classification exists to prevent, one layer up.
 *
 * In every OTHER case the COMPARISON's own code is preserved and the refused cleanup is DISCLOSED beside it. Cleanup
 * failure only ever RAISES the exit code, and only from "no finding" (`0`) to `6`. It is never substituted for `4` or
 * `5`, because an undecidable side is a statement about the evaluated state and must not be hidden behind a directory.
 *
 * Whatever this rule decides, the PRINTED `exit:` is the PROCESS exit. There is no ordering in which a reader of the
 * report can see a number the shell will not agree with.
 */
const REGRESS_EXIT_PRECEDENCE =
  'a finding (1) outranks a refused cleanup: cleanup failure raises a NO-FINDING exit 0 to 6 and is otherwise disclosed beside the comparison code without replacing it';
const REGRESS_EXIT_RULE = {
  rule: REGRESS_EXIT_PRECEDENCE,
  finding_outranks_cleanup: true,
  cleanup_refusal_raises_only_from: REGRESS_EXIT_NO_FINDING,
  printed_exit_equals_process_exit: true,
};
/**
 * Per-INVOCATION instance identity (R5). The old labels were the fixed constants `regress-good`/`regress-target` and the
 * workspace key is deterministic, so two concurrent comparisons of the same pair addressed the SAME two directories:
 * one was degraded to `cannot_compare` by the other's `git worktree add`, and the loser then died on an unguarded
 * `unlinkSync` — a decidable pair reported as undecidable because two operators typed the same command. Each
 * invocation now names itself, and the name is a bounded token under `WORKSPACE_INSTANCE_RE` (40 characters).
 */
const REGRESS_INSTANCE = { good: 'regress-good', target: 'regress-target' };
/**
 * A CENSUS SIDE IS NOT A COMPARISON SIDE. `harness census` measures a RANGE, so its per-commit observations reuse
 * `regressRunSide` — the same workspace preparation, the same `evaluate --step` child, the same `classifyRegressSide` —
 * and give it a role of its own so an instance label can never be mistaken for a `regress` side. The prefix carries the
 * role, the invocation and the commit's index in the range, so no two census commits in one run, and no two runs, can
 * ever share a directory.
 */
const CENSUS_INSTANCE_PREFIX = 'census-';
const REGRESS_INVOCATION_LENGTH = 10;
/** The `--run-origin` value a comparison stamps on each of its two `evaluate` children, so `report` can disclose them. */
const REGRESS_RUN_ORIGIN_KIND = 'regress_comparison';
const REGRESS_ARTIFACT_KIND = 'harness_regress_comparison';
// 3: ADDITIVE. Every field `--repeat` introduced is new (`repeat`, `trials`, `trials_full`, `trial_provenance`,
// `trials_log`) and `sides` keeps exactly the shape it had at version 2, so a reader that ignores the new keys sees the
// version-2 artifact byte-for-byte. At N = 1 the new fields describe the single observation that already decided the
// verdict, and the verdict, the exit code and the terminal output are unchanged.
const REGRESS_ARTIFACT_SCHEMA_VERSION = 3;
/**
 * Every verdict in `compareRegressSides` is derived from exactly ONE observation per side. That is not a defect to
 * hide behind a word like "verdict"; it is the fact a reader needs in order to weigh the direction the tool just printed.
 */
const REGRESS_VERDICT_BASIS = 'single_observation';
const REGRESS_VERDICT_BASIS_TEXT =
  'ONE observation per side: the gate ran once on each named commit. A single observation cannot distinguish a flaky predicate from a real difference, so this direction is an OBSERVATION, never a proof';
/**
 * R2, the residual limit, stated in the same voice as everything else: a gate whose BEHAVIOUR changes while its script
 * TEXT does not is still invisible here. The digest over script definitions closes the "regression fixed by deleting
 * the test" shape; it does not close "same script, different machine".
 */
const REGRESS_GATE_EXECUTION_LIMIT =
  'a gate whose BEHAVIOUR changes without its script text changing is still invisible to this digest; this records WHAT each side ran, never WHY it produced the exit code it did';

/**
 * P4 — what `status_hash_pre` / `status_hash_post` actually are, measured rather than described.
 *
 * They are a digest of `git status --porcelain`. That is a WORKING-TREE DELTA digest, not a tree identity and not a
 * commit identity. Measured on this repository: a clean tree is `e3b0c44298fc`; adding an untracked derived artefact
 * moves it to `9b5eecbf4494`; and a COMMIT CHANGE ON A CLEAN TREE LEAVES IT BYTE-IDENTICAL, because `git status`
 * prints nothing either way. The same blind spot has a second face: the digest also moves for a regenerated untracked
 * artefact (this project's `ui/package.json` `pretest` regenerates `ui/public/themes/manifest.json` — gitignored today,
 * but not at every historical commit), so a `tree_moved` decision can be degraded by a build product on either side of
 * a commit boundary.
 *
 * The defect was never the description in `docs/schemas.md`, which is accurate. The defect was the classifier relying
 * on this one signal as its movement detector. It is now one of two, and the load-bearing one is the pair of
 * judged-commit samples the classifier compares directly.
 */
const REGRESS_STATUS_HASH_SCOPE = {
  is: 'a digest of git status --porcelain: a WORKING-TREE DELTA, not a tree identity and not a commit identity',
  detects: 'an untracked, added, deleted, renamed or modified path appearing or disappearing between the two samples',
  cannot_detect:
    'a COMMIT change on a clean tree (git status prints nothing either way, so the digest is byte-identical); this is why the side classifier pairs it with the TWO judged-commit samples and never decides movement from it alone',
  also_moves_for:
    'a regenerated untracked artefact — a build product can therefore make a tree_moved decision without anything about the code changing',
  measured:
    'clean tree e3b0c44298fc; one untracked derived artefact 9b5eecbf4494; a commit change on a clean tree leaves the digest byte-identical',
};
const REGRESS_STATUS_HASH_LIMIT =
  'status_hash is a digest of git status --porcelain, NOT a tree identity: a commit change on a clean tree leaves it byte-identical, and a regenerated untracked artefact moves it. Movement is therefore decided by the two judged-commit samples FIRST; the digest is a second, weaker signal and is disclosed as one.';

const REGRESS_LIMITATIONS = [
  'regress is NON-CAUSAL: it attaches no ledger, appends no evaluations[]/environments[]/verification[] entry, and sets no status. It enters no denominator in any LEDGER-derived denominator, and it is NOT invisible in `report`: each side is an ordinary gate-bearing `evaluate` run, so `report` counts both and discloses them under comparison_sourced_runs. The verdict is a printed and recorded observation, never a task verdict.',
  'a worktree is not a security boundary, and historical reproducibility is not result authenticity. A same-principal writer still controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger, and no field here proves a result authentic.',
  'a single observation cannot distinguish a flaky acceptance predicate from a genuine difference between two commits. --confirm-disagreement adds a second observation; it does not fix this and never flips a verdict.',
  "a correct npm ci under THIS npm is not the tree the commit's own npm would have produced, and no historical Node version is installed here.",
  'recorded NO-GO: automatic git bisect. A project-wide gate predicate is not monotone (a break is later fixed), git has no representation for a flaky predicate, and mapping INCONCLUSIVE onto git\'s 125 "skip" suppresses the very commit that would explain it. It stays unimplemented — no flag, no stub.',
  `every verdict is derived from ${REGRESS_VERDICT_BASIS_TEXT}.`,
  `a comparison records WHAT each side's gate actually ran (gate_execution_digest: the resolved gate plus the judged commit's own definitions of the scripts that gate invokes) and discloses a difference prominently. It does not make that difference a verdict, and ${REGRESS_GATE_EXECUTION_LIMIT}.`,
  REGRESS_STATUS_HASH_LIMIT,
  'a side is INCONCLUSIVE whenever its two judged-commit samples disagree, or when either of them is not the requested commit. Two samples are two samples, not a proof, but a side whose commit is not pinned by BOTH of them decides nothing.',
];

/**
 * The whole per-side decision, as ONE function over a plain facts object, so the self-test can drive every boundary
 * without a repository. It is a comparison-only classifier: it writes nothing, and `classification` is not a terminal
 * status (the eight-state machine in `verification-state.mjs` is untouched and knows nothing about this function).
 */
function classifyRegressSide(facts) {
  // The provenance the PAIR decision reads travels with the state, always. Returning only `{state, reason}` would make
  // `compareRegressSides` depend on the caller having happened to merge the raw facts back in — a coupling that reads as
  // a bug the moment a caller does not, and one whose failure mode is a verdict naming `undefined` instead of a commit.
  const decide = (state, reason) => ({
    state,
    reason,
    observed_judged_commit: facts.observed_judged_commit ?? null,
    // P1: the SECOND sample travels with the state for the same reason the first does. Returning only the pre-gate
    // value made the pair decision and every printed line blind to the fact that the commit moved.
    observed_judged_commit_post: facts.observed_judged_commit_post ?? null,
    gate_exit_code: facts.gate_exit_code ?? null,
    failing_step: facts.failing_step ?? null,
  });

  // ERROR first: when the tool did not do its job, nothing about the state was learned, and every later check would be
  // reasoning about an absence.
  if (facts.harness_error !== null) {
    return decide(
      'ERROR',
      `a harness/operational failure — the command could not be run to completion: ${facts.harness_error}`,
    );
  }

  if (facts.gate_incompatible === true) {
    return decide('ERROR', 'the gate is gate_incompatible in this workspace, so no gate result exists to compare');
  }

  if (facts.workspace_refused !== null) {
    return decide('INCONCLUSIVE', `the workspace preparation was refused or unusable: ${facts.workspace_refused}`);
  }

  // UNDEFINED IS NOT A FAIL, AND NOT A PASS EITHER. A per-step run against a commit whose own manifests declare no
  // such script spawned nothing and has no exit code. Without this the classifier fell through to the
  // `gate_exit_code === 0` branch, compared `null` against 0 and reported the side FAIL — a red side manufactured out
  // of the ABSENCE of a declaration, which is precisely the laundering `UNDEFINED` exists to prevent. It sits after the
  // workspace-preparation refusal because a refused workspace is a more fundamental "there is nothing here" than an
  // undefined step, and before every pass/fail derivation.
  if (facts.step_undefined === true) {
    return decide(
      'INCONCLUSIVE',
      `the named step "${facts.step_requested ?? '(unrecorded)'}" is UNDEFINED here (${facts.step_undefined_reason ?? 'the judged commit manifests do not declare the script it runs'}), so no command was spawned, no exit code exists, and this side is neither PASS nor FAIL and can produce no direction. ${STEP_SCOPE_UNDEFINED_BASIS}`,
    );
  }

  if (facts.environment_record === null) {
    return decide(
      'INCONCLUSIVE',
      'no environment record was written for this run, so its dependency provisioning is unknown',
    );
  }

  if (facts.status_hash_pre !== facts.status_hash_post) {
    return decide(
      'INCONCLUSIVE',
      `the tree moved while the gate ran (status_hash ${facts.status_hash_pre ?? 'null'} -> ${facts.status_hash_post ?? 'null'})`,
    );
  }

  if (facts.resolver_escaped === true) {
    return decide('INCONCLUSIVE', "the resolver probe resolved a dependency OUTSIDE this side's own workspace");
  }

  // P1 — the two judged-commit samples, and the check the movement digest cannot make for us.
  //
  // `observed_judged_commit` is the PRE-gate sample and `observed_judged_commit_post` the POST-gate one. A gate that
  // runs `git checkout` mid-step leaves a CLEAN worktree, so `status_hash` is byte-identical and the pre-only
  // classifier attributed the result to a commit the gate never ran against: reproduced as `already_failing` / exit 0,
  // a no-finding, for a commit that demonstrably passes. Any disagreement between the two samples is therefore
  // undecidable, and BOTH must name the requested commit — a post-gate sample of some other commit is the same
  // failure with the evidence on the other side.
  const observedPre = facts.observed_judged_commit ?? null;
  const observedPost = facts.observed_judged_commit_post ?? null;

  if (observedPre !== null && observedPost !== null && observedPre !== observedPost) {
    return decide(
      'INCONCLUSIVE',
      `the OBSERVED judged commit MOVED while the gate ran (${observedPre} before the gate, ${observedPost} after it), so this side's result is bound to neither commit and cannot decide a comparison. status_hash is a digest of git status --porcelain and is byte-identical across a commit change on a clean tree, so it cannot see this on its own.`,
    );
  }

  if (observedPre !== facts.requested_commit) {
    return decide(
      'INCONCLUSIVE',
      `the OBSERVED judged commit (${observedPre ?? 'not observed'}) is not the requested commit (${facts.requested_commit ?? 'unresolved'}), so this side's result is not bound to the commit that was asked for`,
    );
  }

  if (observedPost !== null && observedPost !== facts.requested_commit) {
    return decide(
      'INCONCLUSIVE',
      `the OBSERVED judged commit after the gate (${observedPost}) is not the requested commit (${facts.requested_commit ?? 'unresolved'}), so this side's result is not bound to the commit that was asked for`,
    );
  }

  if (facts.contract_digest_differs === true) {
    return decide('INCONCLUSIVE', 'the two sides answered different contracts (contract_digest differs)');
  }

  if (facts.gate_differs === true) {
    return decide('INCONCLUSIVE', 'the two sides ran different resolved gates');
  }

  // A mechanically ATTEMPTED but undecidable acceptance blocks a verdict. An acceptance that was never supplied is
  // reported and is not itself a blocker: `regress` compares the mechanical gate outcome, and a missing human act is
  // an absent input, not an undecidable one.
  if (facts.acceptance_unresolved === true) {
    return decide('INCONCLUSIVE', 'mechanical acceptance is unresolved with incomplete coverage, so no verdict exists');
  }

  return facts.gate_exit_code === 0
    ? decide('PASS', 'the gate ran to completion and every step exited 0')
    : decide(
        'FAIL',
        `the gate ran to completion and failed at step ${facts.failing_step ?? '(unrecorded)'} (exit ${facts.gate_exit_code})`,
      );
}

/**
 * The pair decision. `INCONCLUSIVE != PASS` and `INCONCLUSIVE != FAIL` are enforced STRUCTURALLY: the direction is a
 * lookup over the two decidable states only, so an undecidable side has no row to enter and nothing to launder.
 */
/** Every direction the pair decision can reach is stamped with the basis it was derived from. R1: one observation. */
function withRegressVerdictBasis(decision) {
  return {
    ...decision,
    verdict_basis: REGRESS_VERDICT_BASIS,
    observations_per_side: 1,
    verdict_basis_text: REGRESS_VERDICT_BASIS_TEXT,
    withdrawal: null,
  };
}

function compareRegressSides(good, target) {
  return withRegressVerdictBasis(compareRegressSidesDirection(good, target));
}

/**
 * R1 — the confirmation may REFUSE a direction, never assert one.
 *
 * `--confirm-disagreement` is opt-in and non-authoritative, and that stays true: `flips_verdict` is `false` because a
 * single re-run cannot distinguish a flaky predicate from a real difference, and no amount of re-running one command
 * makes that distinction. What changes is what the tool is ALLOWED to do with the disagreement it has already observed.
 * Printing a finding the same program has just seen contradicted is laundering in a new place: the reader is told
 * "regression, exit 1" and is never told that a second execution of the very same step disagreed. So a CONTRADICTED
 * direction is WITHDRAWN to `cannot_compare`, with the reason printed, and no new direction is substituted — withdrawing
 * is refusing, and the tool still never invents.
 *
 * Three properties make this safe to state as a rule rather than a hope:
 *   - it can only ever move a decision TOWARD `cannot_compare`, never between two directions;
 *   - agreement (a second observation that matches) leaves the decision byte-identical, so a deterministic predicate
 *     behaves exactly as it did before;
 *   - with no second observation at all (`null`, or `performed: false`) nothing is touched.
 */
function applyRegressConfirmation(decision, confirmation) {
  const noWithdrawal = { ...decision, withdrawal: null, confirmation_withdrawal: 'not_applicable' };

  if (confirmation === null || confirmation === undefined || confirmation.performed !== true) {
    return noWithdrawal;
  }

  const first = confirmation.observations?.[0]?.exit_code ?? null;
  const second = confirmation.observations?.[1]?.exit_code ?? null;

  // An unusable observation decides nothing: a re-run that could not produce an exit code is an absence, and
  // reasoning about an absence is the exact error the ERROR/INCONCLUSIVE split exists to prevent.
  if (!Number.isInteger(first) || !Number.isInteger(second)) {
    return { ...noWithdrawal, confirmation_withdrawal: 'not_contradicting' };
  }

  if (first === second) {
    return { ...noWithdrawal, confirmation_withdrawal: 'not_contradicting' };
  }

  if (decision.verdict === 'cannot_compare') {
    return { ...noWithdrawal, confirmation_withdrawal: 'already_undecidable' };
  }

  return {
    verdict: 'cannot_compare',
    reason: `the direction "${decision.verdict}" is WITHDRAWN, not replaced: the second observation of the SAME step contradicted the first (first exit ${first}, second exit ${second}), so this tool has already observed the thing that makes its own direction unsafe to assert. A single observation cannot distinguish a flaky predicate from a real difference, so no new direction is asserted in its place`,
    exit_code: REGRESS_EXIT_INCONCLUSIVE,
    // P1: the decision's OWN basis travels through a withdrawal. A direction derived from N trials is not relabelled
    // `single_observation` on the way out, which would understate what was actually measured.
    verdict_basis: decision.verdict_basis ?? REGRESS_VERDICT_BASIS,
    observations_per_side: decision.observations_per_side ?? 1,
    verdict_basis_text: decision.verdict_basis_text ?? REGRESS_VERDICT_BASIS_TEXT,
    confirmation_withdrawal: 'withdrawn',
    withdrawal: {
      withdrawn: true,
      from_verdict: decision.verdict,
      from_exit_code: decision.exit_code,
      first_observation_exit_code: first,
      second_observation_exit_code: second,
      replaced_by: 'cannot_compare',
      asserted_instead: null,
      rule: 'a confirmation may REFUSE a direction, never assert one: a contradicted direction is withdrawn to cannot_compare and no new direction is invented',
    },
  };
}

function compareRegressSidesDirection(good, target) {
  const name = (side) => (side === null ? 'not observed' : side);
  const errored = [
    ['good', good],
    ['target', target],
  ].filter(([, side]) => side !== null && side.state === 'ERROR');

  if (errored.length > 0) {
    return {
      verdict: 'cannot_compare',
      reason: `a side was never evaluated (a tool failure, not a judged outcome): ${errored.map(([which, side]) => `${which} is ERROR — ${side.reason}`).join('; ')}`,
      exit_code: REGRESS_EXIT_SIDE_ERROR,
    };
  }

  const undecidable = [
    ['good', good],
    ['target', target],
  ].filter(([, side]) => side !== null && side.state === 'INCONCLUSIVE');

  if (undecidable.length > 0) {
    return {
      verdict: 'cannot_compare',
      reason: `a side could not be decided, and an undecidable side is neither good nor bad: ${undecidable.map(([which, side]) => `${which} is INCONCLUSIVE — ${side.reason}`).join('; ')}`,
      exit_code: REGRESS_EXIT_INCONCLUSIVE,
    };
  }

  if (good.state === 'PASS' && target.state === 'PASS') {
    return {
      verdict: 'no_regression',
      reason: `both sides PASS: ${name(good.observed_judged_commit)} and ${name(target.observed_judged_commit)}`,
      exit_code: REGRESS_EXIT_NO_FINDING,
    };
  }

  if (good.state === 'PASS' && target.state === 'FAIL') {
    return {
      verdict: 'regression',
      reason: `the good side ${name(good.observed_judged_commit)} PASSES and the target side ${name(target.observed_judged_commit)} FAILS at step ${target.failing_step ?? '(unrecorded)'} (exit ${target.gate_exit_code})`,
      exit_code: REGRESS_EXIT_FINDING,
    };
  }

  if (good.state === 'FAIL' && target.state === 'FAIL') {
    return {
      verdict: 'already_failing',
      reason: `both sides FAIL: the good side ${name(good.observed_judged_commit)} already failed at step ${good.failing_step ?? '(unrecorded)'} (exit ${good.gate_exit_code}), so the target side ${name(target.observed_judged_commit)} failing is a PRE-EXISTING failure, not a regression introduced between them`,
      exit_code: REGRESS_EXIT_NO_FINDING,
    };
  }

  return {
    verdict: 'improved',
    reason: `the good side ${name(good.observed_judged_commit)} FAILS and the target side ${name(target.observed_judged_commit)} PASSES — this is an improvement, reported as one rather than dressed up as a regression`,
    exit_code: REGRESS_EXIT_NO_FINDING,
  };
}

function readRunStreamEvents(runId) {
  const path = resolveControlPath(RUNS_DIR, `${runId}.jsonl`);

  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null);
}

/** The side-by-side environment fields, and which differences are DISCLOSURES rather than verdicts. */
const REGRESS_ENVIRONMENT_FIELDS = [
  { key: 'judged_commit', read: (s) => s.observed_judged_commit, matters: true },
  // The ATTESTATION's provisioning and installed-state digest, not the run's own: the evaluate run performs no install,
  // so its record says `install: none` and describes nothing about the dependencies the gate actually loaded. Reading
  // the wrong one of two records that both exist is exactly how a side's provenance gets quietly misreported.
  { key: 'dependency_provisioning', read: (s) => s.workspace_provisioning ?? null, matters: true },
  { key: 'installed_state_digest', read: (s) => s.workspace_installed_state_digest ?? null, matters: true },
  {
    key: 'installed_state_digest_source',
    read: (s) => s.environment_record?.installed_state_digest_source ?? null,
    matters: false,
  },
  // F1: the OBSERVED tree digest, disclosed beside npm's declared one. `matters: false` on purpose — a difference here
  // is a disclosure of two different trees, which is often the very thing a comparison is FOR, never a verdict.
  {
    key: 'installed_tree_fingerprint',
    read: (s) => s.workspace_installed_tree_fingerprint ?? null,
    matters: false,
  },
  {
    key: 'installed_tree_fingerprint_tier',
    read: (s) => s.workspace_installed_tree_fingerprint_tier ?? null,
    matters: false,
  },
  // P0: the build and the SOURCE-tree build state. `matters: false` on purpose: a commit that declares a different
  // `build` string is a legitimate difference and is often the very thing a comparison is for. A difference is
  // reported; it is never converted into a regression finding.
  { key: 'historical_build_mode', read: (s) => s.workspace_build_mode ?? null, matters: false },
  { key: 'historical_build_command', read: (s) => s.workspace_build_command ?? null, matters: false },
  { key: 'historical_build_outcome', read: (s) => s.workspace_build_outcome ?? null, matters: false },
  { key: 'build_state_digest', read: (s) => s.workspace_build_state_digest ?? null, matters: false },
  {
    key: 'gate_env_policy',
    read: (s) => s.environment_record?.gate_env_policy ?? null,
    matters: true,
  },
  { key: 'node_modules_scope', read: (s) => s.environment_record?.node_modules_scope ?? null, matters: true },
  { key: 'package_manager', read: (s) => s.environment_record?.package_manager?.version ?? null, matters: true },
  { key: 'node', read: (s) => s.environment_record?.node?.version ?? null, matters: true },
  {
    key: 'platform',
    read: (s) =>
      s.environment_record?.platform === null || s.environment_record?.platform === undefined
        ? null
        : `${s.environment_record.platform.os}/${s.environment_record.platform.arch}`,
    matters: true,
  },
  { key: 'env_vars_digest', read: (s) => s.environment_record?.env?.vars_digest ?? null, matters: true },
  { key: 'lockfile_digest', read: (s) => s.lockfile_digest, matters: true },
  { key: 'contract_digest', read: (s) => s.contract_digest, matters: true },
  { key: 'status_hash_pre', read: (s) => s.status_hash_pre, matters: true },
  { key: 'status_hash_post', read: (s) => s.status_hash_post, matters: true },
];

/**
 * Environment comparison. A DIFFERENCE here is a DISCLOSURE, never a verdict: the two sides may legitimately differ
 * (that is the point of comparing two commits), so converting a difference into a finding would manufacture a
 * regression out of the measurement apparatus. What a disclosure must never do is hide that a side ran with
 * dependencies its own lockfile did not install.
 */
function compareRegressEnvironments(good, target) {
  const differs = [];
  const rows = REGRESS_ENVIRONMENT_FIELDS.map((field) => {
    const left = field.read(good);
    const right = field.read(target);
    const isDifferent = left !== right;

    if (isDifferent) {
      differs.push({ field: field.key, good: left, target: right, matters: field.matters });
    }

    return { field: field.key, good: left, target: right, differs: isDifferent, matters: field.matters };
  });

  const disclosures = [];

  for (const key of ['dependency_provisioning', 'installed_state_digest']) {
    const left =
      key === 'dependency_provisioning'
        ? (good.workspace_provisioning ?? null)
        : (good.workspace_installed_state_digest ?? null);
    const right =
      key === 'dependency_provisioning'
        ? (target.workspace_provisioning ?? null)
        : (target.workspace_installed_state_digest ?? null);

    if (left !== right) {
      disclosures.push({
        kind: key === 'dependency_provisioning' ? 'dependency_provisioning_differs' : 'installed_state_differs',
        detail: `${key}: good=${left ?? 'not recorded'} target=${right ?? 'not recorded'}`,
        authoritative: false,
        prominent: false,
        note: 'a DISCLOSURE, not a verdict: this difference is reported and never converted into a regression finding',
      });
    }
  }

  const comparison = { rows, differs, disclosures, gate_execution: compareRegressGateExecution(good, target) };

  // B5. The pre-fix record said nothing about WHICH trials it compared, and a reader could not tell that a `--repeat=3`
  // artifact's environment table described trial 0 alone. The scope is now stated IN the record, and at N = 1 it reduces
  // to the whole comparison, so an ordinary run's environment block is unchanged.
  comparison.trial_0_only = true;
  comparison.trials_compared = 1;
  comparison.scope = 'trial_0_only';
  comparison.scope_basis =
    'the rows above compare trial 0 of each side ONLY. At --repeat=N>1 the other trials are compared separately in environment_comparison_across_trials, and a field that varies across them is itself evidence, not noise';

  return comparison;
}

/**
 * B5. THE SAME COMPARISON ACROSS EVERY TRIAL. Two problems, both structural, both fixed here rather than annotated.
 *
 * 1. INVISIBILITY. With `--repeat=3` and a non-deterministic historical build, the same commit produced three different
 *    `build_state` digests. `environment_comparison` was built from trial 0 alone and its JSON contained neither of the
 *    other two, so a trial-0 table stood in the artifact looking like a statement about the comparison.
 * 2. THE COMPARISON DISAGREED WITH ITSELF. Under the CONTRADICTION rule, a field that is not the same across trials is a
 *    contradiction, and this cycle exists to eliminate unrecorded variables — so a cross-trial disagreement makes BOTH
 *    sides INCONCLUSIVE rather than being reported and then ignored. It is the same class as a flipped trial state: two
 *    answers to one question, and a verdict between them would be a guess.
 */
function compareRegressEnvironmentsAcrossTrials(goodTrials, targetTrials) {
  const good = Array.isArray(goodTrials) ? goodTrials : [];
  const target = Array.isArray(targetTrials) ? targetTrials : [];
  const all = [...good, ...target];
  const fields = REGRESS_ENVIRONMENT_FIELDS.map((field) => {
    const goodValues = good.map((trial) => field.read(trial) ?? null);
    const targetValues = target.map((trial) => field.read(trial) ?? null);
    const values = [...new Set(all.map((trial) => field.read(trial) ?? null))].map((value) => value ?? null);
    const variesWithinGood = new Set(goodValues).size > 1;
    const variesWithinTarget = new Set(targetValues).size > 1;

    return {
      field: field.key,
      matters: field.matters,
      values,
      varies: values.length > 1,
      varies_within_good: variesWithinGood,
      varies_within_target: variesWithinTarget,
      good_values: goodValues,
      target_values: targetValues,
    };
  });
  const varying = fields.filter((field) => field.varies);
  const materialVarying = varying.filter((field) => field.matters);
  // The unrecorded-variable class: a MATERIAL field that is not the same across the trials of one side is a variable the
  // comparison did not record as constant, and it is a contradiction rather than a detail.
  const contradiction = materialVarying.filter((field) => field.varies_within_good || field.varies_within_target);

  return {
    scope: 'all_trials',
    trial_0_only: false,
    trials_compared: all.length,
    trials_per_side: { good: good.length, target: target.length },
    fields,
    varying_fields: varying.map((field) => field.field),
    material_varying_fields: materialVarying.map((field) => field.field),
    contradiction: contradiction.length > 0,
    contradiction_fields: contradiction.map((field) => field.field),
    basis:
      'every trial of both sides is read, not trial 0 alone. A field that varies across trials is evidence that the trials did not observe the same environment, and a MATERIAL field that varies WITHIN one side is a contradiction: under the disagreement rule it makes both sides INCONCLUSIVE rather than producing a direction between two different environments.',
  };
}

/**
 * R2 — WHAT each side's gate actually ran.
 *
 * The lockfile digest records what each commit DECLARES its dependencies are, and it is byte-identical across a pair
 * where one side replaced the gate's own `test` script with `node -e "process.exit(0)"`. Nothing in the record then
 * distinguished "the failure was fixed" from "the assertion was deleted", and the second was reported as `improved`.
 * So each side now digests TWO things together:
 *
 *   1. the RESOLVED gate definition this process will execute (steps, commands, args) plus the process-level
 *      `GATE_DEFINITION_SHA`, and
 *   2. the judged commit's OWN definitions of the scripts that gate invokes, read from the manifests INSIDE the
 *      judged workspace — never from the contract, never from the primary checkout.
 *
 * A difference is a PROMINENT disclosure: printed in its own block inside the comparison, above the routine
 * environment table, and attached to the verdict as `verdict_disclosures`. It is still NOT a verdict — a difference
 * here may legitimately be the very thing a comparison is for. The limit travels with it: a gate whose behaviour
 * changes while its script text does not is still invisible.
 */
function readGateScriptDefinitions(workspaceDirectory, gateName) {
  if (workspaceDirectory === null || workspaceDirectory === undefined || !existsSync(workspaceDirectory)) {
    return { scripts: [], readable: false };
  }

  const seen = new Set();
  const scripts = [];

  for (const step of GATES[gateName] ?? []) {
    const target = gateStepScript(step);

    if (target === null) {
      scripts.push({
        step: step.step,
        package_path: null,
        script: null,
        defined: null,
        value: null,
        reason: 'unsupported step command',
      });
      continue;
    }

    if (seen.has(target.packagePath)) {
      continue;
    }

    seen.add(target.packagePath);

    const absolute = join(workspaceDirectory, target.packagePath);

    if (!existsSync(absolute)) {
      scripts.push({
        step: step.step,
        package_path: target.packagePath,
        script: target.script,
        defined: false,
        value: null,
        reason: 'manifest not found',
      });
      continue;
    }

    let parsed = null;

    try {
      parsed = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch (error) {
      scripts.push({
        step: step.step,
        package_path: target.packagePath,
        script: target.script,
        defined: false,
        value: null,
        reason: `manifest unreadable: ${String(error?.message ?? error)}`,
      });
      continue;
    }

    scripts.push({
      step: step.step,
      package_path: target.packagePath,
      script: target.script,
      defined: parsed?.scripts?.[target.script] !== undefined,
      value: typeof parsed?.scripts?.[target.script] === 'string' ? parsed.scripts[target.script] : null,
      reason: parsed?.scripts?.[target.script] === undefined ? 'script not declared in this manifest' : null,
    });
  }

  return { scripts, readable: true };
}

/** One side's gate-execution digest. Derived ONCE, while the workspace still exists (the report prints after cleanup). */
function observeRegressGateExecution(side, gateName) {
  const steps = (GATES[gateName] ?? []).map((step) => ({ step: step.step, command: step.command, args: step.args }));
  const { scripts, readable } = readGateScriptDefinitions(side.workspace_directory, gateName);
  const material = {
    gate: gateName,
    gate_definition_sha256: GATE_DEFINITION_SHA,
    resolved_steps: steps,
    invoked_script_definitions: scripts,
  };
  const digest = createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);

  return {
    gate: gateName,
    gate_definition_sha256: GATE_DEFINITION_SHA,
    resolved_steps: steps,
    invoked_script_definitions: scripts,
    manifests_readable: readable,
    digest,
    basis: "computed by this program from the resolved gate definition plus the judged workspace's OWN manifests",
    limitation: REGRESS_GATE_EXECUTION_LIMIT,
  };
}

function compareRegressGateExecution(good, target) {
  const left = good?.gate_execution ?? null;
  const right = target?.gate_execution ?? null;
  const differs = left === null || right === null ? null : left.digest !== right.digest;
  const material = differs === true;

  return {
    good: left,
    target: right,
    differs,
    prominent: material,
    kind: 'gate_execution_differs',
    disclosure: {
      kind: 'gate_execution_differs',
      prominent: material,
      authoritative: false,
      detail:
        left === null || right === null
          ? 'the gate each side actually ran was not recorded on at least one side'
          : `the two sides did NOT run the same gate: gate_execution_digest ${left.digest} -> ${right.digest}. A regression "fixed" by neutering or deleting the script the gate invokes is indistinguishable from a real fix by the verdict alone, and the lockfile digest cannot see it`,
      verdict_qualifier:
        'this verdict is QUALIFIED: the two sides did not execute the same gate, so the direction describes two different pieces of work',
      limitation: REGRESS_GATE_EXECUTION_LIMIT,
    },
  };
}

/** R4 — one function decides the process exit, and the report prints exactly what it returns. */
function resolveRegressExitCode({ comparisonExitCode, cleanupFailures = 0 }) {
  const refused = cleanupFailures > 0;

  if (comparisonExitCode === REGRESS_EXIT_FINDING) {
    return {
      exit_code: REGRESS_EXIT_FINDING,
      cleanup_refused: refused,
      raised_by_cleanup: false,
      rule: REGRESS_EXIT_RULE,
    };
  }

  if (refused && comparisonExitCode === REGRESS_EXIT_NO_FINDING) {
    return {
      exit_code: REGRESS_EXIT_CLEANUP_FAILED,
      cleanup_refused: true,
      raised_by_cleanup: true,
      rule: REGRESS_EXIT_RULE,
    };
  }

  return { exit_code: comparisonExitCode, cleanup_refused: refused, raised_by_cleanup: false, rule: REGRESS_EXIT_RULE };
}

/** R5 — a per-invocation token, unique even between two processes started in the same millisecond. */
function regressInvocationId() {
  return `${process.pid.toString(36)}${randomBytes(4).toString('hex')}`.slice(0, REGRESS_INVOCATION_LENGTH);
}

/** Each side gets its OWN instance, and each INVOCATION its own name: two concurrent comparisons can never share a directory. */
function regressInstanceLabel(role, invocationId) {
  return `${REGRESS_INSTANCE[role]}-${invocationId}`.slice(0, 40);
}

// ---------------------------------------------------------------- repeated evaluation: `--repeat=N`
//
// WHY THIS EXISTS, measured rather than assumed. Every number below comes from a real run recorded in
// `.harness/docs/schemas.md` §2b "Repeated evaluation" (titled, because §2b is a DUPLICATE number in that file —
// the other §2b is "History census artifacts"); none of it is intuition.
//
//   1. THE PROTOCOL HAS NO SLOT FOR IT. `git bisect` can only say "good", "bad" or `125` = untestable, and `125`
//      EXCLUDES the commit while the search continues. The commit that would explain the instability is therefore
//      precisely the one that is dropped, and the manual's own words confirm it: skipping a commit adjacent to the
//      target means git cannot tell which was first bad. There is no representation for "ran to completion, the answer
//      is not the same twice", so the answer is biased LATE and in a FIXED direction, not at random.
//   2. IT IS NOT A SMALL EFFECT. On a four-commit fixture (`A` deterministic PASS, `B` flaky at p≈0.2, `C`
//      deterministic PASS, `D` deterministic FAIL; truth = `C`), 40 independent REAL bisects produced a WRONG boundary
//      40/40 times — bimodally, only ever `B` or `D`. The correct answer never appeared in the observed distribution.
//   3. REPETITION IS NOT A REMEDY; IT CAN BE AN AMPLIFIER. A commit that failed only the FIRST run of a session gave
//      58/59 agreement in one block — a one-sided exact bound of p ≤ 0.087 %, fifty-seven times TIGHTER than the
//      4.95 % the same N certifies from zero flips — while failing 9/9 in the condition a bisect step actually runs
//      in, with a byte-identical workspace attestation. Observing a single flip made the number look MORE certain.
//   4. THE VOTE CANNOT BE REPAIRED BY REPETITION. At a flip rate near 0.5 a majority vote is wrong exactly 50 % of the
//      time for EVERY N: the error is in the ESTIMATOR, not in the sample size.
//
// Consequences, all of them structural rather than advisory: the classification is the CONTRADICTION rule and never a
// vote; an undecidable side is never averaged away by its siblings agreeing; the bound travels with its assumption; and
// `INCONCLUSIVE` is named differently from git's skip precisely so the two are never read as the same thing.
const REPEAT_DEFAULT_TRIALS = 1;
const REPEAT_TRIALS_DIR = join(STATE_DIR, 'regress-trials');
/**
 * B6. This is a COUNT, and it is only a count. The pre-fix message called it "the byte bound on the trial log", which
 * described a mechanism that did not exist: `appendRegressTrialEntry` performed no size check and the log was never
 * rotated. The bound that IS enforced is the separate, implemented byte bound below, and the two are now named apart.
 */
const REPEAT_MAX_TRIALS = 299;
/** B6. Measured on this repository's own fixture: ~17.9 KB per trial entry, so 299 trials would reach ~5.3 MiB. */
const REPEAT_TRIALS_LOG_MAX_BYTES = 8 * 1024 * 1024;
const REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS = `REPEAT_TRIALS_LOG_MAX_BYTES = ${REPEAT_TRIALS_LOG_MAX_BYTES} bytes on ${relative(REPEAT_TRIALS_DIR)}, checked by appendRegressTrialEntry BEFORE every append: if the current file size plus the entry this run wants to write would exceed the bound, the append is REFUSED with TRIAL_LOG_BYTE_BOUND_EXCEEDED and no entry is written. This is a SIZE bound, separate from REPEAT_MAX_TRIALS, which is a COUNT of trials per side. Neither is a retention policy: the log is not rotated, so a bound that is never reached simply keeps growing.`;
const REPEAT_CONFIDENCE = 0.95;
const REPEAT_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/**
 * UNCHANGED, deliberately. This is the version the READER accepts, and a version 1 row written before the chain existed
 * is still parsed, still returned, and still refused for replay — a row with no `chain` is untrusted, not unreadable.
 * The chain was therefore added as a purely additive field rather than as a version bump, and the version this program
 * WRITES is a separate, named field below.
 */
const REPEAT_TRIALS_LOG_SCHEMA_VERSION = 1;
/** B3. What a row written by this program carries. Additive to `schema_version`, never a licence to trust an old row. */
const REPEAT_TRIALS_LOG_WRITE_VERSION = 2;
const REPEAT_SESSION_BINDING_SCHEMA_VERSION = 1;
const REPEAT_TRIALS_CHAIN_GENESIS = 'regress-trials-chain-v1';
const REPEAT_TRIALS_CHAIN_LIMIT =
  'WHAT THE CHAIN DOES: each entry carries the digest of the entry before it, so an interior rewrite, an interior removal and a reordered or edited row all break it, and this program DETECTS that. WHAT IT DOES NOT DO: it does not make the log tamper-proof, it does not detect a same-principal writer who rewrites the log AND the head file together, and on its own a chain over the retained rows cannot see a TAIL truncation — which is why the chain head is ALSO recorded in a separate head file and the entry count is compared against it. This is a truncation-or-rewrite detector for THIS PROGRAM, which is a smaller claim than authenticity and is not a substitute for it.';
const REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE =
  "append_only and rewritten describe THIS PROGRAM'S OWN WRITES, and are backed by a detection mechanism: every append extends a per-entry digest chain and republishes the chain head, and both are re-verified on every read. They are NOT a claim that the bytes cannot be altered by anyone with write access to this directory — a same-principal writer controls the log, the head file and this program.";

// ---------------------------------------------------------------- order-aware trial scheduling
//
// MEASURED DEFECT, and it is a false verdict rather than a weakness. On the acceptance fixture whose two commits differ
// by ONE COMMENT LINE and whose predicate alternates on an external counter, this harness reported
// `verdict: regression` / exit 1 on every run, and `--repeat=4` did not rescue it: all four good-side trials were PASS
// and all four target-side trials were FAIL, so k = 0, the bound printed p <= 0.527, and the contradiction rule — the
// ONLY rule this program is allowed to use — never fired. The reason is visible in the trial loop and in nothing else.
//
// The old shape ran every trial of the good side, then every trial of the target side. A defect that is POSITIVELY
// CORRELATED WITH EXECUTION ORDER (a first-run-only failure, a cold cache, a load artefact, a one-shot resource) is
// therefore not noisy WITHIN a side: it is perfectly CONSISTENT BETWEEN them, because the good side was always the one
// that ran first. The `exchangeability: assumed, unverified` caveat names this class in prose, and the machine-readable
// verdict was still a false regression boundary — the one failure mode this whole programme exists to eliminate.
//
// THE FIX IS STRUCTURAL, NOT A FILTER. Trials are INTERLEAVED: the first position inside a trial block ALTERNATES
// between the sides, so trial 0 is good-then-target, trial 1 is target-then-good, and so on. The old alignment
// ("good always first, target always second") no longer exists in any trial, so an order-coupled defect now has to
// disagree with ITSELF, which is exactly the shape the contradiction rule exists to catch. No vote is introduced, no
// threshold is relaxed, and the classification code is untouched.
//
// N = 1 IS THE BACKWARDS-COMPATIBILITY ANCHOR. The schedule for N = 1 is the single block `['good', 'target']` —
// byte-for-byte the pre-`--repeat` order — and at N = 1 nothing about the terminal output, the verdict or the exit
// code changes. The order block is recorded in the artifact at every N, and PRINTED only at N > 1, because the
// repeated-evaluation block was already printed only at N > 1 and moving a line into it is what keeps the N = 1 output
// byte-identical rather than merely similar.
const REGRESS_ORDER_SCHEME_SINGLE = 'single_block';
const REGRESS_ORDER_SCHEME_INTERLEAVED = 'interleaved_rotated';
/** The order this program used before the interleaving existed, named so a reader can see the design is NOT that one. */
const REGRESS_ORDER_LEGACY = 'sequential_all_good_trials_then_all_target_trials';
const REGRESS_ORDER_BASIS =
  'the order in which the two sides were MEASURED, not the order they are reported in. Within a trial block the first position ALTERNATES between the sides, so neither side is permanently the one that ran first. A defect that is positively correlated with execution order therefore has to disagree with ITSELF within a side, which is the disagreement the CONTRADICTION rule is built to catch; run in the old order it could not. It is derived from the trial index alone, so a resumed --repeat-session replays each trial under the position it was measured in and the schedule is a function of N rather than of wall-clock time.';
/**
 * THE RESIDUAL, stated here rather than left for a reader to discover.
 *
 * Interleaving permutes the POSITION a side occupied inside its block. It does not permute TIME. A defect whose outcome
 * is a function of something the rotation leaves invariant — the trial INDEX (its parity), the absolute order of the
 * gate executions across the whole session, a one-shot resource consumed once per session no matter where it sits in
 * a block — stays perfectly consistent across both sides in every trial, and this program CANNOT tell it from a real
 * difference. That is a genuine limit of the design and not a bug in it.
 *
 * WHY NO ADDITIONAL SIGNAL IS ADDED AS A CLASSIFIER: any schedule is periodic, so a defect that is periodic with the
 * schedule's period is aligned with it by construction; and a randomised order would break that alignment at the cost
 * of making the artifact impossible to re-derive, while still being a heuristic — it manufactures apparent
 * exchangeability rather than establishing it, which is precisely the thing this programme refuses to do. A
 * position-conditional split of each side's trials is reported below as a DISCLOSURE and is deliberately not a
 * classification input: any within-side disagreement already fires the contradiction rule, so a position-conditional
 * split is a strict subset of what that rule catches and adding it as a second path would buy a name, not coverage.
 */
const REGRESS_ORDER_RESIDUAL = `WHAT THE INTERLEAVING DOES NOT COVER, stated because a residual left for a reader to find is a defect wearing a limitation as a costume. The rotation permutes the POSITION a side occupied inside its block; it does not permute TIME. A defect whose outcome is a function of something the rotation leaves invariant — the trial INDEX (its parity), the absolute order of gate executions across the whole session, a one-shot resource consumed once per session wherever it sits in a block — remains perfectly consistent across BOTH sides in every trial, and this program cannot distinguish it from a real difference. A defect perfectly aligned to the OLD design ("good always first, target always second in every trial") IS covered: that alignment no longer exists in any trial. Nothing here closes the time-coupled residual, and the period-2 rotation is not claimed to: any schedule is periodic, and a defect periodic with the schedule is aligned with it by construction. Randomising the order would break that alignment while making the artifact impossible to re-derive, and it would still be a heuristic that manufactures apparent exchangeability rather than establishing it — so no such signal is added. A worktree is not a security boundary, and re-running a historical install on this host does not authenticate the result it produces. A same-principal writer controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger, and no field in this record proves a result authentic.`;

/**
 * The trial schedule. A PURE function of the trial count, deliberately: a resumed `--repeat-session` reads a completed
 * trial back out of the append-only log rather than re-measuring it, and a pure function means the position a replayed
 * trial is reported under is the position it was measured under — never a fresh one.
 */
function regressInterleavedSchedule(repeatTrials) {
  return Array.from({ length: repeatTrials }, (_unused, index) =>
    index % 2 === 0 ? ['good', 'target'] : ['target', 'good'],
  );
}

/** The order record: what was measured, in what order, and what that order does not cover. Additive; null-normalised. */
function regressExecutionOrder(repeatTrials) {
  const schedule = regressInterleavedSchedule(repeatTrials);
  // N === 1 reduces to the pre-`--repeat` order, so the record says so rather than claiming an interleaving that has
  // exactly one trial and therefore no second position to alternate into.
  const interleaved = repeatTrials > 1;

  return {
    scheme: interleaved ? REGRESS_ORDER_SCHEME_INTERLEAVED : REGRESS_ORDER_SCHEME_SINGLE,
    rotate_first_position: interleaved,
    positions_per_trial: 2,
    schedule,
    position_by_trial: {
      good: schedule.map((order) => order.indexOf('good')),
      target: schedule.map((order) => order.indexOf('target')),
    },
    schedule_digest: createHash('sha256').update(JSON.stringify(schedule)).digest('hex').slice(0, 16),
    // Named explicitly, so "this is not the old order" is a field a reader can check rather than an assurance.
    legacy_order_replaced: interleaved ? REGRESS_ORDER_LEGACY : null,
    is_legacy_order: false,
    basis: REGRESS_ORDER_BASIS,
    residual: REGRESS_ORDER_RESIDUAL,
  };
}

/**
 * A DISCLOSURE, never a classification input (see `REGRESS_ORDER_RESIDUAL` for why). It groups each side's trials by
 * the position that side occupied and reports the states seen in each position, so a reader can SEE whether the states
 * moved with the position — which is the diagnostic the interleaving is for. At N = 1 every side has one trial, so
 * both positions are incomplete and the record says that rather than implying a split.
 */
function regressPositionConditionalStates(order, goodTrials, targetTrials) {
  const group = (role, trials) => {
    const positions = [0, 1].map((position) => ({
      position,
      trial_indices: trials
        .filter((trial) => order.position_by_trial[role][trial.trial_index] === position)
        .map((trial) => trial.trial_index),
      states: trials
        .filter((trial) => order.position_by_trial[role][trial.trial_index] === position)
        .map((trial) => trial.state),
    }));

    const observed = positions.filter((entry) => entry.states.length > 0);
    const distinct = [...new Set(observed.flatMap((entry) => entry.states))];

    return {
      role,
      positions: positions.map((entry) => ({ ...entry, observed: entry.states.length > 0 })),
      positions_observed: observed.length,
      distinct_states: distinct,
      // A split is only reported when BOTH positions carry trials; one-sided evidence is not a split.
      position_separable: observed.length === 2 && new Set(observed.map((entry) => entry.states.join('+'))).size > 1,
    };
  };

  return {
    scope: 'disclosure_only',
    classification_input: false,
    good: group('good', goodTrials),
    target: group('target', targetTrials),
    basis: `each side's trials grouped by the POSITION that side occupied in its block. This is a DISCLOSURE and is deliberately NOT an input to any classification: a position-conditional split is a strict subset of the within-side disagreement the contradiction rule already catches, so it would add a name and not coverage. It is reported because "the states moved with the position" is the diagnostic the interleaving exists to make visible.`,
  };
}

/** Rule identifiers. Each one names WHICH boundary produced the classification, and they are in the record, not prose. */
const REPEAT_RULE_CONTRADICTION = 'contradiction';
const REPEAT_RULE_UNANIMOUS = 'unanimous_observation';
const REPEAT_RULE_TRIAL_ERROR = 'trial_error_not_averaged_away';
const REPEAT_RULE_TRIAL_INCONCLUSIVE = 'trial_inconclusive_not_averaged_away';
const REPEAT_RULE_NO_TRIALS = 'no_trials_performed';
const REPEAT_RULE_PAIR_INPUT = 'pair_input_disagrees_across_trials';
/**
 * B2. A replayed trial whose recorded properties were NOT re-derived from the run it names cannot decide anything, so it
 * is a boundary of its own and is checked BEFORE any agreement is read. It can never be averaged away by siblings that
 * agree, and it can never produce a direction.
 */
const REPEAT_RULE_TRIAL_UNVERIFIED = 'trial_unverified_not_averaged_away';
const REPEAT_UNDECIDABLE_CAUSE_UNVERIFIED = 'undecidable_by_unverified_trial';
const REPEAT_RULE_IDS = [
  REPEAT_RULE_CONTRADICTION,
  REPEAT_RULE_UNANIMOUS,
  REPEAT_RULE_TRIAL_ERROR,
  REPEAT_RULE_TRIAL_INCONCLUSIVE,
  REPEAT_RULE_NO_TRIALS,
  REPEAT_RULE_PAIR_INPUT,
  REPEAT_RULE_TRIAL_UNVERIFIED,
];

/** B1. The names a replay refusal is refused BY. A refusal with no name is indistinguishable from a bug. */
const REPLAY_REFUSAL_SESSION_BINDING = 'REPLAY_SESSION_BINDING_MISMATCH';
const REPLAY_REFUSAL_CHAIN = 'TRIAL_LOG_CHAIN_BROKEN';
const REPLAY_REFUSAL_DUPLICATE = 'DUPLICATE_TRIAL_INDEX';
const REPLAY_REFUSAL_NAMES = [REPLAY_REFUSAL_SESSION_BINDING, REPLAY_REFUSAL_CHAIN, REPLAY_REFUSAL_DUPLICATE];

/**
 * B8. WHY DETECTION AND NOT A LOCK. The obvious answer to "two concurrent `--repeat` on one session write into one file"
 * is an exclusive per-session lock. This increment built one, measured it against the suite, and REMOVED it, and the
 * reason is a measurement rather than a preference.
 *
 * A lock taken with `O_EXCL` and released on exit is only safe if it is ALWAYS released. `kill -9` does not release it, so
 * recovery has to decide whether the holder is alive, and the honest liveness test is `process.kill(pid, 0)` — which
 * SUCCEEDS against a ZOMBIE. A `kill -9`ed child stays a zombie until its parent reaps it, so the FIRST resume after an
 * interrupted run was refused with "session is held by pid N" and the resume path stopped working for exactly the case
 * it exists to serve. That was measured, not assumed: it is what E20-08 (a real SIGKILL, then a real resume) reported
 * while the lock was in place. A timeout instead only trades the wedge for a race, and the ledger's compare-and-swap is
 * deliberately lock-free for the same reason.
 *
 * Detection has neither defect. A digest chain makes a concurrent append structurally visible — two writers both read
 * "0 rows", both write `chain.index: 0`, and the second no longer sits at its own position — and a trial index recorded
 * twice under two different invocations is a named refusal. A collision is therefore DETECTED and REFUSED, never
 * resolved by silently keeping the first entry. The cost is honest and is paid in work rather than in availability: two
 * concurrent runs do install what they installed, and the comparison is refused afterwards. A worktree is not a
 * security boundary either way.
 */
const REPLAY_CONCURRENCY_BASIS =
  'concurrency is DETECTED, not locked. Two concurrent --repeat runs on one --repeat-session both write their trials; the second breaks the digest chain (it wrote chain.index 0 at line 2) and duplicates a trial index under a different invocation. Both are refused by name and no verdict is emitted. An O_EXCL per-session lock was built, measured against a real SIGKILL-then-resume, and removed: kill -9 never releases it and process.kill(pid, 0) succeeds against a ZOMBIE, so the lock refused the very resume it existed to protect. A lock trades silent corruption for a wedge, and a wedge on the resume path defeats the purpose of the resume path. THE DECISIVE EVIDENCE IS THE RESUME PATH ITSELF: RESUMING NEVER APPENDS. A trial an earlier invocation already completed is replayed, not re-run and not rewritten — re-running a COMPLETE session with the same token replays every trial from the log and writes NOTHING, and growing --repeat on that same token appends exactly the new indices and no others. The lock was therefore never protecting the write that resume performs: the path a lock would have blocked is the path that has no write in it, which is why removing it costs nothing on the normal path — and, for exactly that reason, the cost below cannot be argued away. WHAT DETECTION DOES NOT DO, stated as a COST and not as a footnote: it does NOT recover. A collided token must be ABANDONED — start a fresh --repeat-session; the collided token is never reusable. The interleaved rows are KEPT: nothing is deleted, rewritten or truncated, because that chain is the evidence of the collision and erasing it would destroy the only thing that shows a collision happened. And EVERY later replay of that token re-refuses, permanently: the duplicate trial index and the broken chain are still in the log, there is no repair path, and none is offered. The price of detecting rather than locking is therefore paid in redoing the work and abandoning a token — not in a wedge, and not in a silent merge: two concurrent runs do install what they installed, the comparison is refused afterwards, and neither run is made to look as though it were the only one. A worktree is not a security boundary either way. The standing limitations — the worktree boundary and the standing authenticity limit — are carried in the block comment above and in REPLAY_TRUST_SCOPE, not here, because this string is printed into the aggregate output that `E20-06` holds free of guarantee words.';
/**
 * B2. The same-principal limitation is NOT being fixed here and must not be described as fixed. Forging the bytes of a
 * trial log is trivially within reach of anyone who can write the directory, and no field in this record makes that
 * harder. What is fixed is narrower and is the only thing that was actually wrong: the harness USED TO ASSERT
 * `append_only: true`, `rewritten: false` and a trial `state` it had never checked. A program that says "I observed this"
 * when it observed nothing is the defect; a program that says "I could not check this" is not.
 */
const REPLAY_TRUST_SCOPE =
  'REPLAY TRUST SCOPE. NOT FIXED, AND NOT CLAIMED: a same-principal writer can forge the bytes of a trial log, and this program cannot prevent that — the same writer also controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger, and a worktree is not a security boundary. WHAT IS FIXED is that the harness no longer ASSERTS properties it has not checked. It re-derives a replayed trial state from the run stream that trial names, it verifies the digest chain and the chain head, it binds a session token to the pair it measured, and it refuses a duplicate trial index by name. Each of those turns an unexamined assertion into either a checked observation or a recorded refusal. None of them authenticates a result.';

/**
 * NORMATIVE. The classification is the CONTRADICTION rule. A vote is never used — not a majority, not a best-of, not
 * the last trial, not the most common state — and the reason is in the sentence rather than in a comment: at a flip
 * rate near 0.5 a majority vote is wrong exactly half the time for EVERY N, so repetition cannot rescue it. Only the
 * disagreement rule survives that regime, because it is the only rule that does not have to guess which of two
 * contradictory answers to believe.
 */
const REPEAT_CLASSIFICATION_RULE = `ANY disagreement among the trials makes the side INCONCLUSIVE (rule ${REPEAT_RULE_CONTRADICTION}). A vote is NEVER taken: not a majority, not a best-of, not the last trial, not the most common state. At a flip rate near 0.5 a majority vote is wrong exactly half the time for EVERY N, so repetition is not a remedy — it can be an amplifier — and only the disagreement rule survives that regime. A trial that is ERROR or INCONCLUSIVE is never averaged away by its siblings agreeing.`;
const REPEAT_VOTE_FORBIDDEN =
  'no vote is ever used: not a majority, not a best-of, not the last trial, not the most common state. At a flip rate near 0.5 the majority vote is wrong exactly 50% of the time for every N, so repetition cannot rescue it; only the disagreement rule can.';
/**
 * `INCONCLUSIVE` is NOT git's `125`. The two cases are named differently in the output on purpose. In git, `125`
 * (skip) means "untestable — exclude this commit and keep searching", and it is precisely that exclusion which makes
 * the boundary late and biased. Here the same underlying situation is a NON-RESOLVING classification: it never skips, it
 * never narrows anything, and the other side is never declared the winner in its place.
 */
const REPEAT_NON_RESOLVING =
  'the aggregate is NEVER used to resolve a boundary. INCONCLUSIVE is NON-RESOLVING and is NOT git\'s 125 "skip": in git, skip means "untestable — exclude this commit and keep searching", which drops the very commit that would explain the disagreement and biases the answer LATE in a fixed direction rather than at random. Here the same situation is named differently — INCONCLUSIVE, undecidable_by_contradiction — it never skips, never narrows a search, and never names the other side the winner.';
const REPEAT_UNDECIDABLE_CAUSE_TRIAL = 'undecidable_by_contradiction';
const REPEAT_UNDECIDABLE_CAUSE_TRIAL_STATE = 'undecidable_by_trial';
const REPEAT_EXCHANGEABILITY =
  'exchangeability: assumed, unverified. What breaks it: a POSITIVELY CORRELATED defect — a warm/cold cache, a session-scoped resource, a first-run-only failure, machine load. Under positive correlation the N trials are not N independent draws, the binomial bound is not a bound on anything real, and repetition buys nothing.';
/**
 * WHAT `anti_conservative` IS, stated as arithmetic rather than as an accusation.
 *
 * `tightened_from_zero_flips` compares the exact Clopper-Pearson limit at k against the zero-flip identity for the same
 * N. At k = 1 the exact limit is already about 0.05/n, so essentially EVERY ordinary disagreement tightens the number,
 * including a perfectly EXCHANGEABLE p = 0.01 observation. The flag is therefore a property of k >= 1 and of the
 * monotonicity of the exact bound, and it is NOT by itself evidence of a defect — the previous wording said it was
 * "the visible signature of a defect that is NOT exchangeable", which an ordinary exchangeable observation produces too,
 * and that overstated the measurement.
 *
 * The MEASURED evidence for a non-exchangeable defect is a different, named thing, and it is unchanged and unweakened:
 * a commit that failed only the first run of a session agreed 58/59 times in one block, then failed 9/9 in the
 * condition a boundary-search step actually runs in, with a byte-identical workspace attestation. That trap keeps
 * firing, and the warning below keeps carrying it.
 */
const REPEAT_ANTI_CONSERVATIVE_BASIS =
  'ANTI-CONSERVATIVE: this bound TIGHTENED relative to the zero-flip bound for the same N. WHAT THIS FLAG IS: an ARITHMETIC property of k >= 1 — an exact Clopper-Pearson limit at k=1 is already ~0.05/n, so essentially every ordinary disagreement fires it, INCLUDING a perfectly exchangeable p = 0.01 observation. It is therefore NOT by itself evidence of a defect, and it does not distinguish an exchangeable run from a defective one; the field anti_conservative_is_evidence_of_defect is false and stays false. WHAT THE MEASURED EVIDENCE IS, separately: a commit failing only the first run of a session agreed 58/59 times in one block (bound p <= 0.087 %, fifty-seven times tighter than the 4.95 % the same N certifies from zero flips) while failing 9/9 in the condition a boundary-search step actually runs in, with a byte-identical workspace attestation. THAT is the measured non-exchangeability, and it is what a single flip that tightens the number can be hiding: a measurement defect wearing the costume of certainty. Read the histogram, not the bound, and treat the histogram, not this flag, as the evidence.';
const REPEAT_ANTI_CONSERVATIVE_EVIDENCE_BASIS =
  'anti_conservative_is_evidence_of_defect is false: the flag is the arithmetic of k >= 1 (an exact Clopper-Pearson limit at k=1 is ~0.05/n, so it fires on essentially every ordinary disagreement, including an exchangeable p = 0.01 one) and is not a measurement of a defect. The MEASURED evidence for a non-exchangeable defect is the 58/59-then-9/9 trap recorded in the warning, which is a separate observation and keeps firing on its own evidence.';
/** The zero-flip branch needs no residual check: it is a closed form, not a root find. */
const REGRESS_ZERO_FLIP_EXACTNESS_BASIS =
  'EXACT: this branch is the closed-form identity p <= 1 - alpha^(1/n) evaluated in one arithmetic step, with no root find and no recurrence, so there is nothing for a residual to falsify. "Exact" here names the DERIVATION — the exact one-sided limit, not a normal approximation.';
const REPEAT_UNATTAINABLE_BASIS =
  'UNATTAINABLE: the requested bound cannot be reached at this observed flip rate for ANY N. At p ~ 0.5 no repetition count attains a bound below 0.5, and a majority vote there is wrong exactly half the time, so more trials is not a remedy — the disagreement rule is. Ask a different question rather than asking the same one more times.';
const REPEAT_BOUND_METHOD_ZERO = 'zero_flip_identity_1_minus_alpha_pow_1_over_n';
const REPEAT_BOUND_METHOD_EXACT = 'clopper_pearson_exact_upper_via_inverted_binomial_tail';
const REPEAT_BOUND_NOT_A_LICENCE =
  'this number is an upper limit on a flip probability ASSUMING independent, identically distributed trials. It is not a licence, not a quality measure and not permission to assert a direction: exchangeability is assumed and unverified, and a single observation cannot distinguish a flaky predicate from a real difference between two commits.';
const REPEAT_LIMITATIONS = [
  `the classification rule is the CONTRADICTION rule and ${REPEAT_VOTE_FORBIDDEN}`,
  REPEAT_NON_RESOLVING,
  REPEAT_EXCHANGEABILITY,
  REPEAT_ANTI_CONSERVATIVE_BASIS,
  REPEAT_UNATTAINABLE_BASIS,
  REPEAT_BOUND_NOT_A_LICENCE,
  'a single observation cannot distinguish a flaky predicate from a real difference between two commits, and REPETITION DOES NOT FIX THAT: more draws of the same predicate sharpen the estimate under an assumption the estimate itself cannot check. At p ~ 0.5 the vote is wrong half the time for every N.',
  'measured: 40 independent real bisects on a four-commit fixture (A PASS, B flaky p~0.2, C PASS, D FAIL; truth = C) produced a WRONG boundary 40/40 times, bimodally only ever B or D. The protocol has no representation for "ran to completion, the answer is not the same twice", so it reports one of the wrong answers every time.',
  'regress stays NON-CAUSAL with respect to LEDGER terminal state at N > 1 exactly as it is at N = 1: no ledger is attached, no evaluations[]/environments[]/verification[] entry is appended, and no status is set. Each TRIAL is an ordinary gate-bearing `evaluate` run, so `report` counts 2 x N of them and discloses them under comparison_sourced_runs.',
  'a worktree is not a security boundary, and re-running a historical install on this host does not authenticate the result it produces. A same-principal writer still controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger, and no field here proves a result authentic.',
];
const REPEAT_VERDICT_BASIS = 'repeated_disagreement_rule';
const REPEAT_VERDICT_BASIS_TEXT = `N INDEPENDENT trials per side, each a complete workspace prepare + evaluate with its own instance, run id and provenance. The direction comes from the CONTRADICTION rule: every trial must agree. ${REPEAT_VOTE_FORBIDDEN}`;

/** P1: the printed number is a bound, never a promise. Rounded to 12 significant digits, which is exact enough to compare. */
function roundBound(value) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toPrecision(12));
}

/** The smallest NORMAL double. Below this a double is subnormal and carries fewer than 53 significant bits. */
const REGRESS_TAIL_MIN_NORMAL_SEED = 2.2250738585072014e-308;

/**
 * ln C(n, k) by SUMMING LOGARITHMS rather than by forming the coefficient. C(n, k) itself overflows a double well
 * before n = 180 (C(1030, 515) is already ~1e308), and seeding the recurrence with an overflowed or underflowed
 * coefficient is what made the old tail silently return 0.
 */
function regressLogBinomialCoefficient(n, k) {
  const r = Math.min(k, n - k);
  let total = 0;

  for (let i = 1; i <= r; i += 1) {
    total += Math.log((n - r + i) / i);
  }

  return total;
}

/**
 * P(X >= k | p) in closed form, seeded in LOG SPACE at the first included term and then advanced by the term
 * recurrence.
 *
 * WHY LOG SPACE, MEASURED. The previous implementation seeded `term = (1 - p)^n` and walked the recurrence UP to k.
 * For n >= 180 at any p large enough for k to be near n, that seed underflows to exactly 0 in a double, so the whole
 * tail evaluated 0 for every such p, the bisection saw "tail below alpha" everywhere, and `low` was driven to 1:
 * `regressFlipRateUpperBound(179, 180)` returned 1 — a bound of certainty — while labelling itself `exact: true` and
 * printing an equation it did not solve. The correct Clopper-Pearson upper limit there is 0.973917696671. The error
 * was CONSERVATIVE (it over-reported p) and verdict-neutral, and it was still the one class of wrong this harness's
 * thesis forbids: a record asserting `exact: true` about a computation that did not happen. Seeding at term k in log
 * space makes the first included term representable for every (k, n, p) where the tail is representable at all, and
 * `regressBoundExactness` below turns a residual evaluation back into the `exact` label so the label cannot survive a
 * degenerate evaluator.
 */
function regressBinomialTailAtLeast(k, n, p) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) {
    return null;
  }

  if (p <= 0) {
    return k === 0 ? 1 : 0;
  }

  if (p >= 1) {
    return 1;
  }

  if (k === 0) {
    return 1;
  }

  // P(X >= n | p) = p^n exactly: one term, so no recurrence and no cancellation.
  if (k === n) {
    return Math.min(1, Math.max(0, Math.pow(p, n)));
  }

  const ratio = p / (1 - p);
  const step = (index) => ((n - index) / (index + 1)) * ratio;

  // PATH ONE is the original arithmetic, reproduced EXACTLY: seed at (1 - p)^n and walk the recurrence up to the k-th
  // term, then on through the tail. It is kept because it is the arithmetic that produced every published value at
  // small n, down to the last bit, and because two of those values are asserted with `===` rather than a tolerance.
  //
  // It is only accurate while that seed is a NORMAL double. A SUBNORMAL seed is the same defect as a zero seed, one
  // step earlier and far quieter: at n = 196, p ~ 0.976 the seed is ~1e-318, which is eleven orders of magnitude below
  // the smallest normal and carries about three significant bits. Walking 195 steps up from it produced a tail wrong by
  // more than 1e-9 while every intermediate value stayed a finite, plausible-looking double — found by the exact
  // rational reference in the I22 group, not by inspecting this function.
  const seed = Math.pow(1 - p, n);
  let term = seed >= REGRESS_TAIL_MIN_NORMAL_SEED ? seed : 0;

  // The seed IS term 0, so the k-th term is `k` multiplications away, not `k - 1`.
  for (let i = 0; term > 0 && i < k; i += 1) {
    term *= step(i);
  }

  // PATH TWO is the fix, taken wherever PATH ONE's seed is not a normal double — zero or subnormal. The k-th term is
  // formed in log space and the same recurrence continues from there.
  if (term === 0) {
    term = Math.exp(regressLogBinomialCoefficient(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));

    // The first included term is below double precision even in log space. Every later term is a fraction of it for k
    // above the mode, so the true tail is below double precision too: 0 is the correct rounding, and
    // `regressBoundExactness` is what notices that this is a zero rather than a solution.
    if (term === 0) {
      return 0;
    }
  }

  let total = term;

  for (let i = k; i < n; i += 1) {
    term *= step(i);
    total += term;
  }

  return Math.min(1, Math.max(0, total));
}

/**
 * The root of P(X >= k | p) = alpha, by bisection. The tail is strictly decreasing in p for 0 < k <= n, so the bracket
 * is total; 100 halvings resolve p to 2^-100, far below the 12 significant digits anything is printed at.
 *
 * It returns what it OBSERVED, not just a number: `underflowed` is set when the evaluator answered an interior point
 * of the bracket with 0, which for a monotone continuous tail between 0 and 1 means the evaluator is degenerate and
 * whatever number came out is not a root. That is the A1 defect made visible by the code that has the defect's
 * symptom, so the `exact: true` label cannot be reached through a broken evaluator.
 */
function regressInvertBinomialTail(k, n, alpha, evaluate = regressBinomialTailAtLeast) {
  let low = 0;
  let high = 1;
  let underflowed = false;
  let unusable = null;

  for (let step = 0; step < 100; step += 1) {
    const mid = (low + high) / 2;
    const at = evaluate(k, n, mid);

    if (at === null || typeof at !== 'number' || Number.isNaN(at)) {
      unusable = 'the tail evaluator returned no usable value at an interior point of the bisection bracket';
      break;
    }

    if (at === 0) {
      underflowed = true;
    }

    // The tail is DECREASING in p, so a tail still ABOVE alpha means p is too small and the upper half of the bracket
    // comes down. Getting this the wrong way round returns the reflection of the bound, which for k=1 is a number
    // indistinguishable from certainty — the exact failure mode a "bound" must not have.
    if (at > alpha) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return { value: unusable === null ? (low + high) / 2 : null, underflowed, unusable };
}

/** The largest |P(X >= k | p*) - alpha| this program will call EXACT. Double precision leaves far more headroom. */
const REGRESS_TAIL_RESIDUAL_MAX = 1e-9;

/**
 * Is the number the record is about to publish actually the solution of the equation it prints? This is the `exact`
 * LABEL, and it is computed by RESIDUAL rather than asserted.
 *
 * `exact: false` is not a lesser claim — it is the honest one, and it is the claim this record has to be able to make.
 * A bound that says `exact: true` while solving nothing is the single class of wrong the whole harness thesis is
 * about, so the label is derived from an independent re-evaluation of the tail at the published value.
 */
function regressBoundExactness({ k, n, alpha, value, underflowed, unusable, evaluate = regressBinomialTailAtLeast }) {
  const notExact = (basis) => ({ exact: false, basis, residual_at_bound: null, value });

  if (unusable !== null && unusable !== undefined) {
    // Every `exact: false` states it in the same two words, so a reader (and an assertion) never has to know which
    // failure branch produced the refusal.
    return notExact(`NOT EXACT: ${unusable}`);
  }

  if (underflowed === true) {
    return notExact(
      'NOT EXACT: the tail evaluator returned 0 at an interior point of the bisection bracket, so it is degenerate there and the number this inversion returned is NOT a root of the printed equation. This is the measured failure of the former seed-(1-p)^n recurrence, which underflowed to 0 for n >= 180 at p large enough for k to be near n and drove the bound to 1. Treat the value as an upper limit with no claimed derivation',
    );
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return notExact(
      `NOT EXACT: the inverted bound ${String(value)} is not a number in [0, 1], so no tail evaluation can corroborate it`,
    );
  }

  const at = evaluate(k, n, value);
  const residual = at === null || typeof at !== 'number' || !Number.isFinite(at) ? null : Math.abs(at - alpha);

  if (residual === null) {
    return notExact(
      'NOT EXACT: re-evaluating the tail at the published bound produced no usable value, so the record cannot corroborate its own number',
    );
  }

  if (residual > REGRESS_TAIL_RESIDUAL_MAX) {
    return notExact(
      `NOT EXACT: re-evaluating the tail at the published bound gives |P(X >= ${k} | p) - ${alpha}| = ${residual}, above this program's own ${REGRESS_TAIL_RESIDUAL_MAX} tolerance, so the published number does not solve the printed equation`,
    );
  }

  return {
    exact: true,
    basis: `EXACT: re-evaluating the tail at the published bound gives |P(X >= ${k} | p) - ${alpha}| = ${residual}, within this program's own ${REGRESS_TAIL_RESIDUAL_MAX} tolerance. No degenerate evaluation was observed anywhere along the bisection bracket. "Exact" here names the DERIVATION (the Clopper-Pearson limit itself, not a normal approximation) and is checked, not asserted`,
    residual_at_bound: residual,
    value,
  };
}

/**
 * The EXACT one-sided upper bound on the per-trial flip probability p, and which of the two exact derivations produced
 * it. Both are exact; neither is an approximation, and this is stated rather than implied.
 *
 *   k = 0  the zero-flip identity, p <= 1 - alpha^(1/N). This is the safe direction: it is the loosest limit any N can
 *          certify from zero disagreements, and it happens to be the Clopper-Pearson value at k = 0, so the two
 *          derivations agree where they meet instead of switching conventions silently.
 *   k >= 1 the Clopper-Pearson EXACT one-sided upper limit, p <= BetaInv(1 - alpha; k + 1, N - k), computed here as
 *          the root of the binomial tail P(X >= k | p) = alpha. It is exact: the interval is not widened, shrunk or
 *          approximated to make it fit a normal approximation.
 */
function regressFlipRateUpperBound(k, n, confidence = REPEAT_CONFIDENCE, options = {}) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(k) || k < 0 || k > n) {
    return null;
  }

  const alpha = 1 - confidence;

  if (k === 0) {
    return {
      n,
      k,
      confidence,
      alpha,
      value: roundBound(1 - Math.pow(alpha, 1 / n)),
      method: REPEAT_BOUND_METHOD_ZERO,
      formula: `k=0: p <= 1 - alpha^(1/${n}) with alpha = 1 - confidence = ${alpha} — the exact one-sided limit for 0 disagreements in ${n} trials, and also the Clopper-Pearson value at k=0`,
      exact: true,
      exactness_basis: REGRESS_ZERO_FLIP_EXACTNESS_BASIS,
      tail_residual_at_bound: null,
      approximation: 'none: this is an exact identity',
      solves: `P(X >= 0 | p) = (1-p)^${n} = ${alpha}`,
    };
  }

  // `evaluateTail` is a TEST SEAM, not a configuration surface: the self-test passes the former, defective evaluator
  // through it to prove the `exact` label flips to `false` on exactly the input that used to be labelled exact. No
  // caller of the CLI supplies it, and it defaults to the log-space evaluator above.
  const evaluateTail = typeof options?.evaluateTail === 'function' ? options.evaluateTail : regressBinomialTailAtLeast;
  const inverted = regressInvertBinomialTail(k, n, alpha, evaluateTail);
  const exactness = regressBoundExactness({
    k,
    n,
    alpha,
    value: inverted.value,
    underflowed: inverted.underflowed,
    unusable: inverted.unusable,
    evaluate: evaluateTail,
  });

  return {
    n,
    k,
    confidence,
    alpha,
    value: exactness.value === null ? null : roundBound(exactness.value),
    method: REPEAT_BOUND_METHOD_EXACT,
    formula: `k>=1: p <= BetaInv(1 - alpha; ${k + 1}, ${n - k}) — the Clopper-Pearson EXACT one-sided upper limit, computed as the root of the binomial tail (evaluated in log space, seeded at the first included term) and inverted by bisection (2^-100)`,
    exact: exactness.exact,
    exactness_basis: exactness.basis,
    tail_residual_at_bound: exactness.residual_at_bound,
    approximation: exactness.exact
      ? 'none: the tail is closed-form, the log-space seed does not underflow, and the inversion is a bisection to 2^-100 rather than a normal approximation'
      : `NOT an approximation and NOT exact: ${exactness.basis}`,
    solves: `P(X >= ${k} | p) = ${alpha}`,
  };
}

/**
 * Did observing a disagreement make the number TIGHTER than the zero-flip bound for the same N? It does, and it is a
 * warning rather than a curiosity: the tightest-looking number in the block is the one produced by the run whose
 * defect was positively correlated, i.e. the run that would mislead a boundary search worst. A correct exact bound
 * tightens with k, so this flag is about what the tightening MEANS, not about the arithmetic being wrong.
 */
function regressBoundTightened(bound, boundAtZero) {
  if (bound === null || boundAtZero === null) {
    return null;
  }

  return bound.value < boundAtZero.value;
}

/** The bound record a reader sees, with everything the number is not, attached to it. */
function regressBoundRecord(k, n, confidence = REPEAT_CONFIDENCE) {
  const bound = regressFlipRateUpperBound(k, n, confidence);
  const zero = regressFlipRateUpperBound(0, n, confidence);
  const tightened = regressBoundTightened(bound, zero);

  return {
    confidence,
    n,
    k,
    value: bound === null ? null : bound.value,
    method: bound === null ? null : bound.method,
    formula: bound === null ? null : bound.formula,
    exact: bound === null ? null : bound.exact,
    approximation: bound === null ? null : bound.approximation,
    solves: bound === null ? null : bound.solves,
    bound_at_zero_flips: zero === null ? null : zero.value,
    tightened_from_zero_flips: tightened,
    exactness_basis: bound === null ? null : bound.exactness_basis,
    tail_residual_at_bound: bound === null ? null : (bound.tail_residual_at_bound ?? null),
    anti_conservative: tightened === true,
    anti_conservative_warning: tightened === true ? REPEAT_ANTI_CONSERVATIVE_BASIS : null,
    // WHAT THE FLAG IS, as data. `tightened` is an arithmetic property of k >= 1: an exact Clopper-Pearson limit at
    // k = 1 is already ~0.05/n, so essentially EVERY ordinary disagreement fires it, including a perfectly
    // exchangeable p = 0.01 observation. This field exists so no reader can mistake the flag for a measurement of a
    // defect. The MEASURED evidence for a non-exchangeable defect is a different thing entirely, and it is named.
    anti_conservative_is_evidence_of_defect: false,
    anti_conservative_evidence_of_defect_basis: REPEAT_ANTI_CONSERVATIVE_EVIDENCE_BASIS,
    exchangeability: REPEAT_EXCHANGEABILITY,
    exchangeability_verified: false,
    unattainable_below_floor: bound !== null && bound.value >= 0.5,
    unattainable_reason: bound !== null && bound.value >= 0.5 ? REPEAT_UNATTAINABLE_BASIS : null,
    floor: 0.5,
    is_a_licence: false,
    is_not_a_licence_because: REPEAT_BOUND_NOT_A_LICENCE,
  };
}

/** One trial, reduced to the fields a reader needs to reconstruct the distribution without re-running anything. */
function regressTrialRecord(trial) {
  return {
    trial_index: trial.trial_index ?? null,
    state: REGRESS_SIDE_STATES.includes(trial.state) ? trial.state : null,
    reason: trial.reason ?? null,
    run_id: trial.run_id ?? null,
    instance: trial.instance ?? null,
    invocation_id: trial.invocation_id ?? null,
    run_origin: trial.run_origin ?? null,
    requested_commit: trial.requested_commit ?? null,
    observed_judged_commit: trial.observed_judged_commit ?? null,
    observed_judged_commit_post: trial.observed_judged_commit_post ?? null,
    workspace_key: trial.workspace_key ?? null,
    workspace_state: trial.workspace_state ?? null,
    lockfile_digest: trial.lockfile_digest ?? null,
    gate: trial.gate ?? null,
    contract_digest: trial.contract_digest ?? null,
    gate_exit_code: trial.gate_exit_code ?? null,
    failing_step: trial.failing_step ?? null,
    status_hash_pre: trial.status_hash_pre ?? null,
    status_hash_post: trial.status_hash_post ?? null,
    gate_env_policy_observed: trial.gate_env_policy_observed ?? null,
    harness_error: trial.harness_error ?? null,
    // B2. `verified` is a CHECK, not a restatement. A trial this invocation measured is verified by construction; a
    // trial replayed from the log is verified only after its recorded gate exit and judged commit were re-read from the
    // run stream it names and its recorded state was re-derived from them. `null` means "not stated", which is what a
    // historical record and a hand-built one read as, and is never silently upgraded to true.
    verified: trial.verified ?? null,
    verification_basis: trial.verification_basis ?? null,
    verification_reason: trial.verification_reason ?? null,
    verification_checked: Array.isArray(trial.verification_checked) ? trial.verification_checked : null,
  };
}

/**
 * The aggregate. It is a SEPARATE structure from the observations: nothing here overwrites a trial, and every trial
 * stays readable in `trials` and in the append-only trial log.
 *
 * The rule, in the order it is applied. A trial that is ERROR is a statement about the TOOL; a trial that is
 * INCONCLUSIVE is a statement about the EVALUATED STATE; PASS and FAIL are judgements. ERROR and INCONCLUSIVE are
 * checked first precisely so a majority of PASS/FAIL trials can never average them away, and the PASS/FAIL contradiction
 * is checked before any agreement is read. Only if every trial says the same thing is the side classified as what the
 * trials observed.
 */
function classifyRegressTrials(trials, requested = null) {
  const list = Array.isArray(trials) ? trials : [];
  const n = list.length;
  const requestedTrials = Number.isInteger(requested) ? requested : n;
  const counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0 };
  const observations = list.map((trial) => ({
    trial_index: trial.trial_index ?? null,
    state: REGRESS_SIDE_STATES.includes(trial.state) ? trial.state : 'ERROR',
    reason: trial.reason ?? null,
    run_id: trial.run_id ?? null,
    instance: trial.instance ?? null,
    observed_judged_commit: trial.observed_judged_commit ?? null,
    gate_exit_code: trial.gate_exit_code ?? null,
    failing_step: trial.failing_step ?? null,
    verified: trial.verified ?? null,
    verification_reason: trial.verification_reason ?? null,
  }));
  // B2. An EXPLICITLY unverified trial — one this program replayed and could not re-derive — is a boundary of its own,
  // checked before any agreement is read, and it can never be averaged away by trials that agree with it.
  const unverified = observations.filter((observation) => observation.verified === false);

  for (const observation of observations) {
    counts[observation.state] += 1;
  }

  const modal = REGRESS_SIDE_STATES.reduce(
    (best, state) => (counts[state] > counts[best] ? state : best),
    REGRESS_SIDE_STATES[0],
  );
  const k = n === 0 ? 0 : n - counts[modal];
  const conflicts = observations.filter((observation) => observation.state !== modal);
  const observedCommits = [...new Set(observations.map((observation) => observation.observed_judged_commit))];

  let classification;
  let ruleId;
  let undecidableCause = null;

  if (n === 0) {
    classification = 'ERROR';
    ruleId = REPEAT_RULE_NO_TRIALS;
  } else if (unverified.length > 0) {
    classification = 'INCONCLUSIVE';
    ruleId = REPEAT_RULE_TRIAL_UNVERIFIED;
    undecidableCause = REPEAT_UNDECIDABLE_CAUSE_UNVERIFIED;
  } else if (counts.ERROR > 0) {
    classification = 'ERROR';
    ruleId = REPEAT_RULE_TRIAL_ERROR;
  } else if (counts.INCONCLUSIVE > 0) {
    classification = 'INCONCLUSIVE';
    ruleId = REPEAT_RULE_TRIAL_INCONCLUSIVE;
    undecidableCause = REPEAT_UNDECIDABLE_CAUSE_TRIAL_STATE;
  } else if (counts.PASS > 0 && counts.FAIL > 0) {
    classification = 'INCONCLUSIVE';
    ruleId = REPEAT_RULE_CONTRADICTION;
    undecidableCause = REPEAT_UNDECIDABLE_CAUSE_TRIAL;
  } else {
    classification = modal;
    ruleId = REPEAT_RULE_UNANIMOUS;
  }

  const describe = (observation) =>
    `trial ${observation.trial_index ?? '?'} = ${observation.state} (run ${observation.run_id ?? 'none'}, commit ${observation.observed_judged_commit ?? 'not observed'}, gate exit ${observation.gate_exit_code ?? 'none'})`;

  let reason;

  if (n === 0) {
    reason = `no trial was performed, so nothing was observed and a side that was not measured is ERROR, never a pass`;
  } else if (ruleId === REPEAT_RULE_TRIAL_UNVERIFIED) {
    reason = `at least one of the ${n} trials is UNVERIFIED — its recorded state was not re-derived from the run it names — so this side is INCONCLUSIVE and the agreeing trials do NOT average it away: ${unverified.map(describe).join('; ')}. Why each is unverified: ${unverified.map((observation) => observation.verification_reason ?? 'unrecorded').join(' | ')}. ${REPLAY_TRUST_SCOPE}`;
  } else if (ruleId === REPEAT_RULE_TRIAL_ERROR) {
    reason = `at least one of the ${n} trials was ERROR — a tool failure, not a judged outcome — and the agreeing trials do NOT average it away: ${conflicts.map(describe).join('; ')}. The full reason: ${conflicts.map((observation) => observation.reason ?? 'unrecorded').join(' | ')}`;
  } else if (ruleId === REPEAT_RULE_TRIAL_INCONCLUSIVE) {
    reason = `at least one of the ${n} trials was itself INCONCLUSIVE, and the agreeing trials do NOT average it away: ${conflicts.map(describe).join('; ')}. The full reason: ${conflicts.map((observation) => observation.reason ?? 'unrecorded').join(' | ')}`;
  } else if (ruleId === REPEAT_RULE_CONTRADICTION) {
    reason = `the ${n} trials of this side DISAGREED — ${counts.PASS} observed PASS and ${counts.FAIL} observed FAIL — so the side is INCONCLUSIVE. This is the CONTRADICTION rule, not a vote: ${REPEAT_VOTE_FORBIDDEN} Conflicting observations: ${conflicts.map(describe).join('; ')}`;
  } else if (classification === 'PASS') {
    reason = `all ${n} trials observed PASS (${observations.map(describe).join('; ')}). Agreement across trials is a fact about these ${n} runs under an assumption nothing here verifies — it is not a proof and it is not a licence`;
  } else {
    reason = `all ${n} trials observed FAIL (${observations.map(describe).join('; ')}). Agreement across trials is a fact about these ${n} runs under an assumption nothing here verifies — it is not a proof and it is not a licence`;
  }

  return {
    classification,
    classification_rule_id: ruleId,
    classification_rule: REPEAT_CLASSIFICATION_RULE,
    // B2: the whole point of the unverified boundary. A side that could not be classifiable says so, and no direction
    // is derived from it anywhere.
    classifiable: unverified.length === 0,
    vote_used: false,
    vote_forbidden: REPEAT_VOTE_FORBIDDEN,
    reason,
    trials_requested: requestedTrials,
    trials_performed: n,
    trials_complete: requestedTrials === null ? null : n === requestedTrials,
    state_counts: counts,
    unverified_trials: unverified.length,
    unverified_trial_indices: unverified.map((observation) => observation.trial_index),
    observations,
    conflicting_observations: conflicts,
    k,
    flip_rate_observed: n === 0 ? null : roundBound(k / n),
    // What a vote WOULD have said, recorded so that the refusal is legible rather than invisible. This is a disclosure
    // of arithmetic that was NOT used: it is never an input to the classification and never a candidate verdict.
    majority_not_taken: {
      // A STRICT majority of one decidable state: both PASS and FAIL present AND more than half the trials on one side.
      // A tie has no majority, which is a different situation from a majority that was refused, and the record says which.
      available: counts.PASS > 0 && counts.FAIL > 0 && counts[modal] > n / 2,
      state: counts.PASS > 0 && counts.FAIL > 0 ? modal : null,
      votes_for_it: counts.PASS > 0 && counts.FAIL > 0 ? counts[modal] : null,
      votes_needed: n === 0 ? null : Math.floor(n / 2) + 1,
      tie: counts.PASS > 0 && counts.FAIL > 0 && counts.PASS === counts.FAIL,
      taken: false,
      refused_because: REPEAT_VOTE_FORBIDDEN,
    },
    // The DIRECTION is unattainable exactly when a vote was available and was refused. No binomial bound can change
    // that: at a flip rate near 0.5 the vote is wrong exactly half the time for every N, whatever the number says.
    direction_attainable: classification === 'INCONCLUSIVE' && ruleId === REPEAT_RULE_CONTRADICTION ? false : null,
    direction_unattainable_reason:
      classification === 'INCONCLUSIVE' && ruleId === REPEAT_RULE_CONTRADICTION ? REPEAT_UNATTAINABLE_BASIS : null,
    observed_judged_commits: observedCommits,
    agreed_judged_commit: observedCommits.length === 1 ? observedCommits[0] : null,
    bound: regressBoundRecord(k, n),
    undecidable_cause: undecidableCause,
    git_skip_125_equivalent: false,
    skippable: false,
    resolves_boundary: false,
    resolving_note: REPEAT_NON_RESOLVING,
    limitations: [...REPEAT_LIMITATIONS, REPLAY_TRUST_SCOPE],
  };
}

/**
 * The pair-decision input for an aggregated side. It is DERIVED, never a mutation: the trial objects keep their own
 * `state`, and this object is what the direction lookup reads. The direction lookup is the SAME one the single-observation
 * path uses, so `INCONCLUSIVE != PASS` and `INCONCLUSIVE != FAIL` stay structural at N > 1 exactly as they are at N = 1.
 */
function regressAggregateDecisionSide(role, aggregate, primaryTrial) {
  return {
    role,
    state: aggregate.classification,
    reason: aggregate.reason,
    observed_judged_commit: aggregate.agreed_judged_commit,
    observed_judged_commit_post: primaryTrial?.observed_judged_commit_post ?? null,
    gate_exit_code: primaryTrial?.gate_exit_code ?? null,
    failing_step: primaryTrial?.failing_step ?? null,
    classification_rule_id: aggregate.classification_rule_id,
    classifiable: aggregate.classifiable,
    trials_performed: aggregate.trials_performed,
    trials_requested: aggregate.trials_requested,
    k: aggregate.k,
    bound: aggregate.bound,
  };
}

/** P1: the basis of a direction derived from N trials is the disagreement rule, never "one observation". */
function withRegressAggregateBasis(decision, repeatTrials) {
  return {
    ...decision,
    verdict_basis: REPEAT_VERDICT_BASIS,
    observations_per_side: repeatTrials,
    verdict_basis_text: REPEAT_VERDICT_BASIS_TEXT,
    withdrawal: null,
  };
}

/**
 * P1: the N = 1 anchor. At N = 1 the basis is the pre-`--repeat` one, byte for byte; only N > 1 is relabelled. Making
 * this a single dispatch rather than a branch at each call site is what keeps the default path a provable identity
 * rather than a claim about it.
 */
function applyBasis(decision, repeatTrials) {
  return repeatTrials === 1 ? withRegressVerdictBasis(decision) : withRegressAggregateBasis(decision, repeatTrials);
}

/**
 * P1: `--repeat=N`. Refused BY NAME, before any workspace is created, when it is not a usable count. A silent fallback
 * to 1 would be the worst possible reading of a flag an operator typed to change the strength of a measurement.
 */
function resolveRepeatTrials(raw) {
  if (raw === undefined) {
    return REPEAT_DEFAULT_TRIALS;
  }

  if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw)) {
    fail(`regress --repeat=<N> requires a positive integer, got: ${String(raw)}`);
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1 || value > REPEAT_MAX_TRIALS) {
    // B6. The pre-fix text called REPEAT_MAX_TRIALS "the byte bound on the trial log". It never was one: it is a COUNT
    // of trials per side, `appendRegressTrialEntry` performed no size check, and the log was never rotated. The bound
    // that IS enforced now — REPEAT_TRIALS_LOG_MAX_BYTES, checked before every append — is named separately below, so
    // the message no longer describes a mechanism that does not exist.
    fail(
      `regress --repeat=<N> must be between 1 and ${REPEAT_MAX_TRIALS} (a COUNT of trials per side), got: ${raw}. The trial log's own bound is a separate SIZE limit of ${REPEAT_TRIALS_LOG_MAX_BYTES} bytes, enforced before every append; it is not what this number is. ${REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS}`,
    );
  }

  return value;
}

/**
 * B1. THE SESSION BINDING. A `--repeat-session=<token>` is only ever a NAME; nothing stopped one token being replayed
 * against a completely different pair, task, gate or environment policy, and the replay path compared none of them even
 * though all of them were already in every log row. The result was an artifact whose own `requested` block named commits
 * its `sides` and `trials` had nothing to do with, replayed as if freshly measured, emitting a `regression` finding with
 * exit 1 about two commits the operator never asked about.
 *
 * The binding is a digest over exactly the things that decide what a trial MEANS. A token now names one comparison, and
 * asking it a different question is refused by name rather than answered with the wrong measurements.
 */
function regressSessionBinding({ taskId, gateName, goodRef, goodCommit, targetRef, targetCommit, gateEnvPolicy }) {
  const subject = {
    schema_version: REPEAT_SESSION_BINDING_SCHEMA_VERSION,
    task_id: taskId ?? null,
    gate: gateName ?? null,
    requested: { good: goodRef ?? null, target: targetRef ?? null },
    resolved: { good: goodCommit ?? null, target: targetCommit ?? null },
    gate_env_policy: gateEnvPolicy ?? null,
  };

  return { ...subject, binding_digest: createHash('sha256').update(canonicalJson(subject)).digest('hex').slice(0, 32) };
}

/** The names whose difference refuses a replay. Each is compared by VALUE, and each is reported by name. */
const REPLAY_SESSION_BINDING_FIELDS = [
  { key: 'task_id', read: (b) => b.task_id },
  { key: 'gate', read: (b) => b.gate },
  { key: 'requested.good', read: (b) => b.requested?.good ?? null },
  { key: 'requested.target', read: (b) => b.requested?.target ?? null },
  { key: 'resolved.good', read: (b) => b.resolved?.good ?? null },
  { key: 'resolved.target', read: (b) => b.resolved?.target ?? null },
  { key: 'gate_env_policy', read: (b) => b.gate_env_policy },
];

/**
 * B1. Compare a recorded binding against the one this invocation would write. Every differing field is NAMED. A binding
 * that is absent is a refusal too, not a pass: a log written by an older version, or a hand-written one, has not
 * established what it measured, and "I could not check it" is the only honest reading.
 */
function compareRegressSessionBindings(recorded, current) {
  const differences = [];

  if (recorded === null || typeof recorded !== 'object') {
    differences.push({
      field: 'session_binding',
      recorded: null,
      current: current.binding_digest,
      reason:
        'the log records no session binding, so nothing establishes which pair, task, gate or environment policy these trials measured',
    });

    return differences;
  }

  for (const field of REPLAY_SESSION_BINDING_FIELDS) {
    const left = field.read(recorded);
    const right = field.read(current);

    if (left !== right) {
      differences.push({ field: field.key, recorded: left, current: right, reason: 'differs from this invocation' });
    }
  }

  if (differences.length === 0 && recorded.binding_digest !== current.binding_digest) {
    differences.push({
      field: 'binding_digest',
      recorded: recorded.binding_digest ?? null,
      current: current.binding_digest,
      reason: 'the recorded digest does not match these fields, so the binding was edited after it was written',
    });
  }

  return differences;
}

/**
 * B2. RE-DERIVE a replayed trial from the run stream it names. The pre-fix path trusted the `state` written into the log
 * and never opened the run at all, so a hand-written three-line JSONL naming a run id that never existed produced three
 * PASS trials, a `no_regression` verdict, and exit 0 — about a commit that genuinely fails.
 *
 * This routine re-reads the run's OWN `run_finished` event, requires the recorded `gate_exit_code` and `judged_commit`
 * to be the ones that event carries, and re-derives the side state from them rather than believing the log. Every
 * failure is a named reason, and every one of them makes the trial `verified: false`.
 */
function verifyRegressTrialAgainstRunStream(trial, role) {
  const checked = [];
  const unverified = (reason, detail = null) => ({
    verified: false,
    basis:
      "the trial's recorded properties were RE-DERIVED from the run stream it names; a trial whose run stream does not exist, has no run_finished, disagrees on gate_exit_code or judged_commit, or whose recorded state is not the state those facts re-derive, is marked unverified and the side is not classifiable from it",
    reason,
    detail,
    checked,
    role,
  });
  const verified = () => ({
    verified: true,
    basis:
      "the trial's recorded gate_exit_code and judged_commit were re-read from the run stream it names, and the recorded state is the state those two facts re-derive",
    reason: null,
    detail: null,
    checked,
    role,
  });

  if (trial === null || typeof trial !== 'object') {
    return unverified('trial_object_missing', 'the log row carries no side object to verify');
  }

  const runId = typeof trial.run_id === 'string' && trial.run_id !== '' ? trial.run_id : null;

  if (runId === null) {
    return unverified('no_run_id_recorded', 'the trial names no run, so there is nothing to re-derive it from');
  }

  const events = readRunStreamEvents(runId);

  if (events.length === 0) {
    return unverified(
      'run_stream_not_found',
      `no run stream exists at ${relative(join(RUNS_DIR, `${runId}.jsonl`))}: a run id this program never issued cannot vouch for a state`,
    );
  }

  checked.push('run_stream_exists');

  const started = events.find((event) => event?.event === 'run_started');
  const finished = events.find((event) => event?.event === 'run_finished');

  if (started === undefined) {
    return unverified(
      'run_stream_has_no_run_started',
      `the run stream for ${runId} holds ${events.length} event(s) and none of them is run_started, so it was never this program's run of anything`,
    );
  }

  if (finished === undefined) {
    return unverified(
      'run_stream_has_no_run_finished',
      `the run stream for ${runId} holds ${events.length} event(s) and none of them is run_finished, so the run never reached a state this program can read`,
    );
  }

  checked.push('run_started_present', 'run_finished_present');

  // The gate exit is the run's OWN `run_finished` field, and the judged commit is the run's OWN `run_started` field —
  // read from the stream, not from the log row that is being checked. The writer spreads a payload onto the event
  // itself, so the fields are at the TOP LEVEL; the `payload` fallback keeps a differently-shaped stream readable rather
  // than silently reading `undefined` and reporting a disagreement that is really a shape mismatch.
  const finishedGateExit = finished.gate_exit_code ?? finished.payload?.gate_exit_code ?? null;
  const runCommit = normalizeCommitSha(started.judged_commit ?? started.payload?.judged_commit ?? null);

  if (finishedGateExit !== trial.gate_exit_code) {
    return unverified(
      'gate_exit_code_disagrees_with_run_stream',
      `the trial records gate_exit_code ${String(trial.gate_exit_code ?? null)} and the run recorded ${String(finishedGateExit ?? null)}`,
    );
  }

  if (runCommit !== (trial.observed_judged_commit ?? null)) {
    return unverified(
      'judged_commit_disagrees_with_run_stream',
      `the trial records judged_commit ${String(trial.observed_judged_commit ?? null)} and the run recorded ${String(runCommit ?? null)}`,
    );
  }

  checked.push('gate_exit_code_agrees', 'judged_commit_agrees');

  // The state is RE-DERIVED from the two facts that were just checked, not read from the log.
  const derived = classifyRegressSide({
    ...trial,
    gate_exit_code: finishedGateExit,
    observed_judged_commit: runCommit,
  }).state;

  checked.push('state_re_derived');

  if (derived !== trial.state) {
    return unverified(
      'state_disagrees_with_run_stream',
      `the trial records state ${String(trial.state ?? null)} and the run's own gate exit ${String(finishedGateExit)} at ${String(runCommit ?? null)} re-derives ${String(derived)}`,
    );
  }

  return verified();
}

/** The limitations every replay refusal prints. The refusals themselves are the mechanism; these are their reach. */
const REPLAY_REFUSALS = [
  REPLAY_TRUST_SCOPE,
  REPEAT_TRIALS_CHAIN_LIMIT,
  REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE,
  REPLAY_CONCURRENCY_BASIS,
];

/** B2. Attach the re-derivation verdict to a replayed side. The side object is COPIED, never the log row mutated. */
function withTrialVerification(side, role) {
  const verdict = verifyRegressTrialAgainstRunStream(side, role);

  return {
    ...side,
    verified: verdict.verified,
    verification_basis: verdict.basis,
    verification_reason: verdict.verified === true ? null : verdict.reason,
    verification_detail: verdict.verified === true ? null : verdict.detail,
    verification_checked: verdict.checked,
  };
}

/**
 * B1 + B3 + B8. THE REPLAY GATE. Three refusals, each by name, each before a workspace exists.
 *
 * The pre-fix reader compared NOTHING. `requested`, `task_id`, `gate` and the environment policy were all present in
 * every log row and none was read, so one token answered two different comparisons and the artifact's own `requested`
 * block named commits its `sides` and `trials` had nothing to do with — with three trials marked
 * `replayed_from_trial_log | written: 0` and a `regression` finding at exit 1 about two commits it was not asked about.
 */
function regressReplayRefusal({ logRead, sessionBinding, regressSession }) {
  if (regressSession === null || logRead.entries.length === 0) {
    return null;
  }

  const chain = logRead.chain;

  if (chain.duplicate_trial_indices.length > 0) {
    return {
      refusal: REPLAY_REFUSAL_DUPLICATE,
      lines: [
        `the trial log holds ${chain.duplicate_trial_indices.length} trial index/indices more than once under different invocations: ${chain.duplicate_trial_indices.map((entry) => `trial ${entry.trial_index} at lines ${entry.first_line + 1} and ${entry.second_line + 1}`).join('; ')}.`,
        'Two concurrent --repeat runs on one --repeat-session produced this, and the pre-fix replay silently kept the FIRST',
        'entry per index, which collapsed two independent measurements into one with no diagnostic at all. It is now',
        'refused rather than resolved. Start a fresh --repeat-session=<token>, or remove the colliding rows deliberately.',
      ],
    };
  }

  if (chain.verified !== true) {
    return {
      refusal: REPLAY_REFUSAL_CHAIN,
      lines: [
        chain.break_reason ?? 'the digest chain does not verify',
        chain.head_reason,
        `entries on disk: ${chain.entries}; entries this program is willing to trust: ${chain.verified_entries}.`,
        'A log this program cannot verify is not repaired and not partially believed: the comparison is refused so that no',
        'verdict is ever derived from bytes nobody checked.',
      ].filter((line) => line !== null && line !== undefined),
    };
  }

  // The binding is read from the HEAD entry, which is the one that established the session and the one the chain commits
  // to. A binding that is absent is a refusal, not a pass.
  const differences = compareRegressSessionBindings(
    logRead.entries[logRead.entries.length - 1]?.session_binding ?? null,
    sessionBinding,
  );

  if (differences.length > 0) {
    return {
      refusal: REPLAY_REFUSAL_SESSION_BINDING,
      lines: [
        'this --repeat-session token measured a DIFFERENT comparison. The session is bound to the pair, the task, the gate and the gate environment policy, and the following differ from this invocation:',
        ...differences.map(
          (difference) =>
            `  ${difference.field}: recorded ${String(difference.recorded ?? 'not recorded')} / this invocation ${String(difference.current ?? 'not recorded')} — ${difference.reason}`,
        ),
        "A token that is not bound to its comparison replays the wrong measurements and reports them as this pair's, so it",
        'is refused by name here. Use a fresh --repeat-session=<token>, or pass exactly the comparison the token measured.',
      ],
    };
  }

  return null;
}

/** P1: `--repeat-session=<token>` names the append-only trial log a re-run resumes. Bounded, and never a path. */
function resolveRepeatSession(raw) {
  if (raw === undefined) {
    return null;
  }

  if (typeof raw !== 'string' || !REPEAT_SESSION_RE.test(raw)) {
    fail(
      `regress --repeat-session=<token> requires a bounded token ([A-Za-z0-9][A-Za-z0-9._-]{0,39}), got: ${String(raw)}`,
    );
  }

  return raw;
}

/** P1: the trial log is APPEND-ONLY. One JSON object per completed trial, fsynced, never rewritten and never truncated. */
function regressTrialsLogPath(sessionId) {
  return resolveControlPath(REPEAT_TRIALS_DIR, `regress-trials-${sessionId}.jsonl`);
}

/**
 * B3. The chain head is published SEPARATELY from the log rows, which is the only thing that makes a TAIL truncation
 * observable: an unbroken chain over the retained rows cannot distinguish "these were all the rows" from "the rest were
 * deleted", because a chain never commits to a length. A head file that records the entry count and the last digest
 * does, and the two disagreeing is a detection.
 */
function regressTrialsLogHeadPath(sessionId) {
  return resolveControlPath(REPEAT_TRIALS_DIR, `regress-trials-${sessionId}.head.json`);
}

/** B3. One entry's digest. It commits to the entry's own bytes AND to the previous entry's digest, so the chain links. */
function regressTrialEntryDigest(entry, prevDigest) {
  const body = { ...entry };

  delete body.chain;

  return createHash('sha256')
    .update(
      canonicalJson({
        genesis: REPEAT_TRIALS_CHAIN_GENESIS,
        prev_digest: prevDigest,
        entry: body,
      }),
    )
    .digest('hex');
}

/** B3. Publish the chain head atomically (temp + fsync + rename), so a crash never leaves a half-written head. */
function writeRegressTrialsLogHead(path, head) {
  prepareControlRoot(REPEAT_TRIALS_DIR);

  const temp = join(REPEAT_TRIALS_DIR, `.${basenameOf(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(head, null, 2)}\n`);
  const fd = openSync(temp, 'wx');

  try {
    writeAll(fd, bytes, DEFAULT_FS);
    fsyncSync(fd);
  } finally {
    closeDescriptor(fd, DEFAULT_FS);
  }

  renameSync(temp, path);
}

function basenameOf(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * B3 + B6. The append is the ONLY writer of the log, and it is where the byte bound now lives. The bound is checked
 * BEFORE the bytes are written, so exceeding it leaves the log exactly as it was and produces a named refusal rather
 * than a partially written row.
 */
function appendRegressTrialEntry(path, entry, options = {}) {
  const existing = readRegressTrialLogWithChain(path);
  const prevDigest = existing.chain.head_digest;
  const nextIndex = existing.entries.length;
  const body = {
    ...entry,
    write_version: REPEAT_TRIALS_LOG_WRITE_VERSION,
    chain: {
      genesis: REPEAT_TRIALS_CHAIN_GENESIS,
      index: nextIndex,
      prev_digest: prevDigest,
      entry_digest: null,
    },
  };

  body.chain.entry_digest = regressTrialEntryDigest(body, prevDigest);

  const bytes = `${JSON.stringify(body)}\n`;
  const currentBytes = existsSync(path) ? lstatSync(path).size : 0;
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : REPEAT_TRIALS_LOG_MAX_BYTES;

  if (currentBytes + Buffer.byteLength(bytes) > maxBytes) {
    const error = new Error(
      `TRIAL_LOG_BYTE_BOUND_EXCEEDED: the trial log ${path} is ${currentBytes} bytes and this entry would make it ${currentBytes + Buffer.byteLength(bytes)} bytes, over the enforced bound of ${maxBytes} bytes (${REPEAT_TRIALS_LOG_MAX_BYTES} by default). No entry was written and the log is unchanged. The bound is a SIZE limit, separate from REPEAT_MAX_TRIALS, which is a COUNT of trials per side; the log is not rotated, so a bound that is never reached simply keeps growing. Reduce --repeat=<N>, or start a fresh --repeat-session=<token>.`,
    );
    error.code = 'TRIAL_LOG_BYTE_BOUND_EXCEEDED';

    throw error;
  }

  const fd = openSync(path, 'a');

  try {
    writeAll(fd, bytes, DEFAULT_FS);
    fsyncSync(fd);
  } finally {
    closeDescriptor(fd, DEFAULT_FS);
  }

  if (options.headPath !== undefined && options.headPath !== null) {
    writeRegressTrialsLogHead(options.headPath, {
      schema_version: REPEAT_TRIALS_LOG_SCHEMA_VERSION,
      write_version: REPEAT_TRIALS_LOG_WRITE_VERSION,
      chain_genesis: REPEAT_TRIALS_CHAIN_GENESIS,
      session_id: entry.session_id ?? null,
      entries: nextIndex + 1,
      head_digest: body.chain.entry_digest,
      updated_at: new Date().toISOString(),
      verification_basis:
        'the head is the entry COUNT and the LAST digest the append believed it wrote; a log whose rows no longer reach this count or this digest was truncated or rewritten after the fact',
    });
  }

  return body;
}

/** B3. Read the head file, or `null` when it is absent. A head this program cannot parse is NOT trusted as absent. */
function readRegressTrialsLogHead(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));

    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { unreadable: true, entries: null, head_digest: null, reason: 'head file is present but not parsable JSON' };
  }
}

/**
 * B3 + B8. THE VERIFICATION ROUTINE. Every read of a trial log goes through it, and it answers three questions the
 * pre-fix reader never asked:
 *
 *   1. Is the digest chain unbroken? A rewritten, reordered, interior-removed or interior-edited row fails here.
 *   2. Does the separately published head still describe these rows? A TAIL truncation fails here, which an
 *      in-rows chain structurally cannot see.
 *   3. Is any trial INDEX present twice under DIFFERENT invocations? That is the B8 collision, and it is reported as a
 *      duplicate rather than resolved by silently keeping the first.
 */
function readRegressTrialLogWithChain(path, options = {}) {
  const headPath = options.headPath ?? regressTrialsLogHeadPath(sessionFromTrialsLogPath(path));
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const entries = [];
  const parsed = [];
  let malformedLines = 0;
  let prevDigest = null;
  let breakAt = null;
  let breakReason = null;
  const seenIndex = new Map();
  const duplicateIndices = [];
  // The census key, kept separate from the comparison key because the two families write DIFFERENT fields. Merging them
  // would mean keying a census row on a field it never writes, which is exactly how a refusal becomes dead code.
  const seenCensusIndex = new Map();
  const duplicateCensusIndices = [];

  for (let index = 0; index < lines.length; index += 1) {
    let value = null;

    try {
      const candidate = JSON.parse(lines[index]);

      value = candidate !== null && typeof candidate === 'object' ? candidate : null;
    } catch {
      value = null;
    }

    if (value === null) {
      malformedLines += 1;
      parsed.push(null);

      if (breakAt === null) {
        breakAt = index;
        breakReason = `line ${index + 1} is not a JSON object; a log this program cannot parse is never repaired in place`;
      }

      continue;
    }

    const chain = value.chain ?? null;
    const recomputed = regressTrialEntryDigest(value, chain?.prev_digest ?? null);

    if (chain === null || typeof chain !== 'object') {
      if (breakAt === null) {
        breakAt = index;
        breakReason = `line ${index + 1} carries no chain record; entries written before the chain existed are not trusted as verified`;
      }
    } else if (chain.index !== index) {
      if (breakAt === null) {
        breakAt = index;
        breakReason = `line ${index + 1} claims chain index ${String(chain.index)}, which is not its position: a row was removed, reordered or inserted`;
      }
    } else if (chain.prev_digest !== prevDigest) {
      if (breakAt === null) {
        breakAt = index;
        breakReason = `line ${index + 1} commits to a previous digest that is not the digest of the row before it: that row was rewritten, reordered or removed`;
      }
    } else if (recomputed !== chain.entry_digest) {
      if (breakAt === null) {
        breakAt = index;
        breakReason = `line ${index + 1} does not hash to the digest it records: the row was edited after it was written`;
      }
    } else if (index > 0 && chain.prev_digest === null) {
      // A genesis row at a position other than 1 means the rows before it are gone. A row at position 1 that claims a
      // predecessor is already caught above, because the running previous digest is null there.
      if (breakAt === null) {
        breakAt = index;
        breakReason = `line ${index + 1} claims to be the genesis row at position ${index + 1}: earlier rows were removed`;
      }
    }

    prevDigest = chain?.entry_digest ?? null;
    parsed.push(value);
    entries.push(value);

    // THE KEY MUST BE THE FIELD THE ROW ACTUALLY WRITES. A detector keyed on `trial_index` is dead code for a `census`
    // row, because a census row writes `index` and writes neither `trial_index` nor `invocation_id`: two concurrent
    // `--census` runs on one `--census-session` therefore produced twelve rows with indices 0,0,1,1,2,2,..., both
    // exited 1, both published a full artifact, neither disclosed the collision, and each row silently used one of two
    // conflicting measurements of the same commit. A refusal asserted over a key nothing writes is decoration. The census
    // key is `(index, commit)` — a commit measured twice in one range is a collision whatever wrote it, and it is
    // reported with the commit so the refusal is actionable.
    if (value.kind === 'census' && Number.isInteger(value.index)) {
      const key = `${String(value.index)}@${String(value.commit ?? '')}`;
      const seen = seenCensusIndex.get(key);

      if (seen === undefined) {
        seenCensusIndex.set(key, { index: value.index, commit: value.commit ?? null, line: index });
      } else {
        duplicateCensusIndices.push({
          index: value.index,
          commit: value.commit ?? null,
          first_line: seen.line,
          second_line: index,
        });
      }
    } else if (Number.isInteger(value.trial_index)) {
      const seen = seenIndex.get(value.trial_index);

      if (seen === undefined) {
        seenIndex.set(value.trial_index, { invocation_id: value.invocation_id ?? null, line: index });
      } else if (seen.invocation_id !== (value.invocation_id ?? null)) {
        duplicateIndices.push({ trial_index: value.trial_index, first_line: seen.line, second_line: index });
      }
    }
  }

  // Only the verified prefix is usable. A break does not delete the tail from disk — it removes it from TRUST.
  if (breakAt !== null) {
    entries.length = Math.min(breakAt, entries.length);
  }

  const head = readRegressTrialsLogHead(headPath);
  let headAgrees = null;
  let headReason = null;

  if (head === null) {
    headAgrees = null;
    headReason =
      'no head file: this log was written by an invocation that published none, so a tail truncation cannot be detected through the head';
  } else if (head.unreadable === true) {
    headAgrees = false;
    headReason = head.reason;
  } else if (Number.isInteger(head.entries) && head.entries !== parsed.length) {
    headAgrees = false;
    headReason = `the head records ${head.entries} entries and the file holds ${parsed.length}: the log was truncated or rows were added out of band`;
  } else if (typeof head.head_digest === 'string' && parsed.length > 0) {
    const lastRow = parsed[parsed.length - 1];

    if ((lastRow?.chain?.entry_digest ?? null) !== head.head_digest) {
      headAgrees = false;
      headReason =
        'the head digest does not match the last row on disk: the log was rewritten or truncated after the last append';
    } else {
      headAgrees = true;
    }
  }

  const verified = breakAt === null && headAgrees !== false;

  return {
    entries,
    all_parsed: parsed,
    chain: {
      genesis: REPEAT_TRIALS_CHAIN_GENESIS,
      bytes: Buffer.byteLength(raw),
      entries: parsed.length,
      verified_entries: entries.length,
      head_digest: prevDigest,
      head_path: relative(headPath),
      head_entries: head === null || head.unreadable === true ? null : (head.entries ?? null),
      head_agrees: headAgrees,
      head_reason: headReason,
      verified,
      break_at: breakAt,
      break_reason: breakReason,
      malformed_lines: malformedLines,
      duplicate_trial_indices: duplicateIndices,
      // The census family, keyed on the field a census row actually writes. Reported beside the comparison family rather
      // than folded into it, so a reader can see WHICH key detected the collision.
      duplicate_census_indices: duplicateCensusIndices,
      census_index_key: 'index@commit',
      trial_index_key: 'trial_index',
      limit: REPEAT_TRIALS_CHAIN_LIMIT,
    },
  };
}

/** The session token a log path names, or `null` when the path is not one of this program's logs. */
function sessionFromTrialsLogPath(path) {
  const name = basenameOf(path);
  const match = /^regress-trials-(.+)\.jsonl$/.exec(name);

  return match === null ? null : match[1];
}

/**
 * P1: exported aliases. The internal names read as verbs on a log; the exported names read as the `regress*` family the
 * self-test drives, and a rename the export list could not express as a shorthand would be a rename it hid.
 */
const regressReadTrialLog = readRegressTrialLog;
const regressResolveSession = resolveRepeatSession;
const regressResolveTrials = resolveRepeatTrials;

/**
 * Read what a previous invocation already completed. A malformed line is dropped, never repaired in place. The returned
 * array is UNCHANGED in meaning — it is the same list of entries — and the chain verdict travels beside it in
 * `regressReadTrialLogVerified`, which every caller in this module now consults.
 */
function readRegressTrialLog(path) {
  return readRegressTrialLogWithChain(path).entries;
}

/** The verified read: entries AND the chain verdict, so no caller can read the rows without the verdict. */
function regressReadTrialLogVerified(path, options = {}) {
  return readRegressTrialLogWithChain(path, options);
}

/**
 * One side, end to end, through the EXISTING paths: `workspace prepare` (its own instance) and then `evaluate` as a
 * child process of this very module. Nothing about the gate, the run stream, the acceptance machinery or the
 * environment record is reimplemented here, and no ledger is attached — that is what makes the command non-causal.
 * A side is identified by the run `regress` itself just performed (`run_id`) and by the OBSERVED `judged_commit` that
 * run recorded, never by directory name, run ordering, `updated_at`, or the contract's declared `source_commit`.
 */
function regressRunSide({
  role,
  ref,
  task,
  gateName,
  extraFlags,
  fingerprintTier,
  invocationId,
  gateEnvPolicy,
  trialIndex = 0,
  stepName = null,
  // Additive and optional: `census` supplies a label that already carries the commit's index in the range, because a
  // census side is one commit of MANY rather than one of a pair, and one label for all of them would put every commit of
  // a range in one instance name. `null` — the `regress` path — leaves the existing `regress-good`/`regress-target`
  // labelling byte-identical.
  instanceLabel = null,
}) {
  // P1: the trial INDEX travels in the identity, and trial 0 is byte-identical to the pre-`--repeat` identity. Two
  // trials of the same side are two INDEPENDENT measurements, so they must never share a workspace instance, a run id
  // or a run origin — and a run stream opened twice with exclusive creation truncates (the R5 shape of E17).
  const trialSuffix = trialIndex === 0 ? '' : `-t${trialIndex}`;
  const side = {
    role,
    requested_ref: ref,
    requested_commit: null,
    instance: instanceLabel ?? regressInstanceLabel(role, `${invocationId}${trialSuffix}`),
    invocation_id: invocationId,
    trial_index: trialIndex,
    gate_env_policy_requested: gateEnvPolicy,
    gate_env_policy_observed: null,
    run_origin: `${REGRESS_RUN_ORIGIN_KIND}:${invocationId}${trialSuffix}`,
    gate_execution: null,
    workspace_key: null,
    workspace_directory: null,
    workspace_state: null,
    workspace_refused: null,
    lockfile_digest: null,
    workspace_install: null,
    workspace_provisioning: null,
    workspace_provisioning_basis: null,
    workspace_installed_state_digest: null,
    workspace_installed_tree_fingerprint: null,
    workspace_installed_tree_fingerprint_tier: null,
    workspace_build_mode: null,
    workspace_build_command: null,
    workspace_build_outcome: null,
    workspace_build_state_digest: null,
    resolver_all_inside: null,
    run_id: null,
    gate: null,
    contract_digest: null,
    observed_judged_commit: null,
    observed_judged_commit_post: null,
    judged_commit_scope: null,
    status_hash_pre: null,
    status_hash_post: null,
    gate_exit_code: null,
    gate_compatibility: null,
    failing_step: null,
    acceptance_verdict: null,
    acceptance_coverage_state: null,
    mechanically_verified: null,
    environment_record: null,
    harness_error: null,
    // Additive, and null on every whole-gate comparison: the per-step request this side was measured under and what the
    // judged commit's own manifests said about it. The side's STATE is derived from these through
    // `classifyRegressSide`, so an UNDEFINED step is INCONCLUSIVE here exactly as it is in the run itself.
    step_scope: null,
    state: null,
    reason: null,
  };

  const resolved = normalizeCommitSha((git(['rev-parse', '--verify', `${ref}^{commit}`], REPO_ROOT) ?? '').trim());

  if (resolved === null) {
    side.harness_error = `UNRESOLVABLE_REF: "${ref}" does not resolve to a commit in this repository`;
    return Object.assign(side, classifyRegressSide(side));
  }

  side.requested_commit = resolved;

  // 1. Prepare. A refusal or an unusable attestation is INCONCLUSIVE, not ERROR: the command ran to completion and
  //    reported that it would not measure this side.
  let prepared = null;

  try {
    prepared = captureCommandOutput(() =>
      cmdWorkspacePrepare({
        commit: ref,
        instance: side.instance,
        gate: gateName,
        fingerprint: fingerprintTier,
        ...extraFlags,
      }),
    );
  } catch (error) {
    if (typeof error?.exitCode === 'number') {
      side.workspace_refused = error.message;
    } else {
      side.harness_error = `workspace prepare failed: ${error?.message ?? error}`;
    }
  }

  if (side.workspace_refused === null && side.harness_error === null) {
    side.workspace_state = prepared.stdout.includes('workspace:              unusable')
      ? 'unusable'
      : prepared.stdout.includes('workspace:              reused')
        ? 'usable'
        : 'usable';
  }

  const attestation = workspaceInstanceEntries(resolved, side.instance).at(-1) ?? null;

  if (attestation === null) {
    side.workspace_refused = side.workspace_refused ?? 'no workspace attestation was written';
  } else {
    side.workspace_key = attestation.workspace_key ?? null;
    side.workspace_directory = attestation.directory ?? null;
    side.workspace_state = attestation.state ?? null;
    side.lockfile_digest = attestation.lockfile_digest ?? null;
    // The attestation — not the run's own environment record — is the record of the HISTORICAL INSTALL this side
    // actually ran against. `evaluate` performs no install of its own, so its record honestly says `install: none`; a
    // reader must not have to guess which of the two describes the dependencies the gate used.
    side.workspace_install = attestation.install ?? null;
    side.workspace_provisioning = attestation.dependency_provisioning ?? null;
    side.workspace_provisioning_basis = attestation.dependency_provisioning_basis ?? null;
    side.workspace_installed_state_digest = attestation.installed_state_digest ?? null;
    // The observation THIS program made, kept beside npm's declaration and never merged with it.
    side.workspace_installed_tree_fingerprint = attestation.installed_tree_fingerprint ?? null;
    side.workspace_installed_tree_fingerprint_tier = attestation.installed_tree_fingerprint_tier ?? null;
    // P0: the BUILD is part of how each side was prepared, so it is disclosed beside the install it followed. A
    // difference here is a DISCLOSURE (two commits may genuinely declare different build commands) and never a verdict.
    side.workspace_build_mode = attestation.historical_build_mode ?? null;
    side.workspace_build_command = attestation.historical_build_command ?? null;
    side.workspace_build_outcome = attestation.historical_build_outcome ?? null;
    side.workspace_build_state_digest = attestation.build_state?.digest ?? null;
  }

  if (side.workspace_state !== 'usable' || side.workspace_directory === null) {
    side.workspace_refused =
      side.workspace_refused ??
      `the workspace is ${side.workspace_state ?? 'unrecorded'} (attestation state ${side.workspace_state ?? 'none'})`;
  }

  if (side.workspace_refused !== null || side.harness_error !== null) {
    return Object.assign(side, classifyRegressSide(side));
  }

  // 2. Evaluate, through the ordinary `evaluate` path, in the prepared worktree, on its own run id. `--quiet` keeps the
  //    gate's output tail out of the comparison; the whole tail is already in the run stream and the gate log.
  //    The INVOCATION is in the id: `generatedRunId` ends in a millisecond timestamp, so two comparisons started in
  //    the same millisecond produced the SAME run id, both `evaluate` children opened the same JSONL with exclusive
  //    creation, and the loser's run stream was truncated — an operational collision surfacing as a side ERROR.
  const runId = generatedRunId(`regress-${role}-${invocationId}${trialSuffix}-${resolved.slice(0, 12)}`);

  side.run_id = runId;

  let evaluated = null;

  try {
    // R3: the policy REACHES the child. It used to be dropped on the floor, so `--gate-env=inherited` was a silent
    // no-op while the artifact reported `sanitised` — a record describing an environment the gate never saw.
    // `--run-origin` (R6) stamps the run so `report` can disclose that it came from a comparison.
    evaluated = captureCommandOutput(() =>
      runHarnessChild([
        'evaluate',
        `--task=${task.id}`,
        `--workspace=${side.workspace_directory}`,
        `--gate=${gateName}`,
        `--run-id=${runId}`,
        `--gate-env=${gateEnvPolicy}`,
        `--run-origin=${side.run_origin}`,
        '--quiet',
        // Per-step mode REACHES the child. `--step` is a real `evaluate` capability validated there against the
        // prepared workspace's own manifests, so the applicability question is answered where the manifests are rather
        // than here in the parent against nothing.
        ...(stepName === null ? [] : [`--step=${stepName}`]),
        ...regressAcceptanceFlags(task),
      ]),
    );
  } catch (error) {
    side.harness_error = `evaluate failed: ${error?.message ?? error}`;
  }

  if (side.harness_error !== null) {
    return Object.assign(side, classifyRegressSide(side));
  }

  const events = readRunStreamEvents(runId);
  const started = events.find((event) => event.event === 'run_started') ?? null;
  const observed = events.find((event) => event.event === 'environment_observed') ?? null;
  const finished = events.find((event) => event.event === 'run_finished') ?? null;

  if (started === null || finished === null) {
    side.harness_error = `the evaluate run ${runId} produced no readable run stream (exit ${evaluated.exitCode})`;
    return Object.assign(side, classifyRegressSide(side));
  }

  side.gate = started.gate ?? null;
  side.contract_digest = started.contract_digest ?? null;
  side.observed_judged_commit = started.judged_commit ?? null;
  side.observed_judged_commit_post = finished.judged_commit_post ?? null;
  side.judged_commit_scope = started.judged_commit_scope ?? null;
  side.status_hash_pre = started.status_hash_pre ?? null;
  side.status_hash_post = finished.status_hash_post ?? null;
  side.gate_exit_code = finished.gate_exit_code ?? null;
  side.gate_compatibility = finished.gate_compatibility ?? null;
  side.failing_step = finished.aborted_after ?? null;
  side.acceptance_verdict = finished.acceptance_verdict ?? null;
  side.acceptance_coverage_state = finished.acceptance_coverage_state ?? null;
  side.mechanically_verified = finished.mechanically_verified ?? null;
  side.environment_record = observed?.environment ?? null;
  // Per-step mode, read back from the CHILD's own run stream rather than predicted by the parent. The parent asked for
  // a step; only the child knows whether the judged commit's manifests declared it, and only the child ran it.
  side.step_scope = finished.step_scope ?? null;
  // R3: what the gate ACTUALLY ran under, read back from the child's own record rather than assumed from the flag.
  side.gate_env_policy_observed = side.environment_record?.gate_env_policy ?? null;
  // R2: WHAT each side's gate ran. Derived here, while the workspace still exists, for the same reason the resolver
  // probe is: a digest re-read at print time would be deciding against a path that no longer resolves.
  side.gate_execution = observeRegressGateExecution(side, gateName);

  // DERIVED ONCE, WHILE THE WORKSPACE STILL EXISTS. The report is printed after cleanup reclaims the directories, and a
  // check re-read at print time would then be deciding against a path that no longer resolves — reporting a resolver
  // escape that never happened, which is precisely the false-regression shape this whole increment exists to remove.
  side.resolver_all_inside =
    side.environment_record !== null && Array.isArray(side.environment_record.resolver_probe)
      ? probeResolvesInsideWorkspace(side.environment_record.resolver_probe, side.workspace_directory)
      : null;

  return Object.assign(
    side,
    classifyRegressSide({
      ...side,
      harness_error: side.gate_compatibility === 'gate_incompatible' ? null : side.harness_error,
      gate_incompatible: side.gate_compatibility === 'gate_incompatible',
      resolver_escaped: side.resolver_all_inside === false,
      acceptance_unresolved: side.acceptance_verdict === 'unresolved',
      // An UNDEFINED step makes this side INCONCLUSIVE — never PASS, never FAIL, never a direction — and it is decided
      // by the SAME `classifyRegressSide` the whole-gate path uses. No second classifier, no per-step exception.
      step_undefined: side.step_scope?.state === 'UNDEFINED',
      step_requested: side.step_scope?.requested ?? null,
      step_undefined_reason:
        side.step_scope?.state === 'UNDEFINED' ? `${side.step_scope.reason}: ${side.step_scope.detail}` : null,
    }),
  );
}

/** Acceptance is read, never invented: an auto verdict is requested only when the contract declares checks for it. */
function regressAcceptanceFlags(task) {
  return Array.isArray(task.acceptance_checks) && task.acceptance_checks.length > 0 ? ['--acceptance=auto'] : [];
}

/** The real `evaluate` entry point, run as a child of this module so its stdout cannot pollute the comparison. */
function runHarnessChild(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  });

  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `prepare` prints a human summary; that summary is not the comparison's output, so it is captured, not relayed. */
function captureCommandOutput(run) {
  const original = process.stdout.write;
  let captured = '';

  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);

    return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1]() : true;
  };

  try {
    return { exitCode: run(), stdout: captured, stderr: '' };
  } finally {
    process.stdout.write = original;
  }
}

/**
 * The opt-in second observation. NON-AUTHORITATIVE by construction: it re-runs the disagreeing side's failing step ONCE
 * and reports BOTH observations, and its result is recorded in the artifact but is NOT an input to the verdict. A
 * single re-run cannot distinguish a flaky predicate from a genuine difference; this is a known limitation, not a fix.
 */
function regressConfirmDisagreement({ target, good, gateName, gateEnvPolicy = GATE_ENV_DEFAULT_POLICY }) {
  const failing = target.state === 'FAIL' ? target : good.state === 'FAIL' ? good : null;

  if (failing === null) {
    return null;
  }

  const steps = GATES[gateName] ?? [];
  const step = steps.find((candidate) => candidate.step === failing.failing_step);

  if (step === undefined || failing.workspace_directory === null) {
    return {
      performed: false,
      authoritative: false,
      reason: `the failing step "${failing.failing_step ?? '(unrecorded)'}" is not a step of gate "${gateName}" in this harness build, so it cannot be re-run`,
      observations: [],
    };
  }

  // R3: the policy is read from the SIDE'S OWN record — what its gate actually got — and not from the flag the
  // operator typed. Re-running under a different environment than the comparison is not a confirmation of anything.
  const observedPolicy = GATE_ENV_POLICIES.includes(failing.gate_env_policy_observed)
    ? failing.gate_env_policy_observed
    : gateEnvPolicy;
  // The SAME environment construction `evaluate` uses under the SAME policy — not a second, wider global behaviour.
  const bundle =
    observedPolicy === 'inherited'
      ? { env: { ...process.env } }
      : constructChildEnv({ extra: defaultEnvironmentInput().extra, refuse: false });
  const startedMs = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: failing.workspace_directory,
    encoding: 'utf8',
    env: bundle.env,
  });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  return {
    performed: true,
    authoritative: false,
    side: failing.role,
    step: step.step,
    command: formatCommand(step),
    // The re-run must use the SAME environment policy the comparison ran under, or it is not a re-run of anything.
    environment_policy: observedPolicy,
    environment_policy_requested: gateEnvPolicy,
    environment_policy_matches_comparison: observedPolicy === gateEnvPolicy,
    observations: [
      {
        observation: 'first (the comparison run)',
        exit_code: failing.gate_exit_code,
        duration_ms: null,
        output_tail: null,
      },
      {
        observation: 'second (--confirm-disagreement re-run)',
        exit_code: Number.isInteger(result.status) ? result.status : null,
        duration_ms: Date.now() - startedMs,
        output_tail: tailLines(combined, OUTPUT_TAIL_LINES, OUTPUT_TAIL_MAX_CHARS) || null,
      },
    ],
    flips_verdict: false,
    // R1: it never ASSERTS a direction. It may WITHHOLD one this program has already observed to be contradicted,
    // which is a refusal rather than a claim, and these are the two flags that say exactly that.
    asserts_direction: false,
    may_withdraw_direction: true,
    contradicts_first_observation:
      Number.isInteger(failing.gate_exit_code) && Number.isInteger(result.status)
        ? failing.gate_exit_code !== result.status
        : null,
    limitation:
      'a single re-run cannot distinguish a flaky acceptance predicate from a genuine difference between the two commits; this second observation is reported, never authoritative, and it never asserts a direction of its own — it may only WITHDRAW a direction the comparison had already observed to be contradicted',
  };
}

/**
 * One line describing a side's per-step answer, for the terminal report. `UNDEFINED` is spelled out rather than
 * rendered as an exit code, because a side whose step did not exist has no exit code and printing one — even a
 * fabricated 0 — would be the laundering the state exists to prevent.
 */
function regressStepScopeBrief(stepScope) {
  if (stepScope === null || stepScope === undefined) {
    return 'whole gate (no step named)';
  }

  return stepScope.state === 'UNDEFINED'
    ? `${stepScope.requested} = UNDEFINED (${stepScope.reason}) — no command was spawned, no exit code exists, and this side is neither PASS nor FAIL`
    : `${stepScope.requested} = ${stepScope.state}, ran ${stepScope.command} once, exit recorded on the side; the OTHER steps of the gate were not run and are not reported here`;
}

function regressSideLines(side) {
  const environment = side.environment_record;
  const label = side.role === 'good' ? 'good   ' : 'target ';
  // The workspace ATTESTATION describes the historical install this side actually ran against. The evaluate run's own
  // environment record is shown beside it, not merged with it: the run performs no install of its own, so its
  // `install` is honestly `none` and would say nothing about the dependencies the gate loaded.
  const provisioning =
    side.workspace_provisioning === null
      ? 'not recorded'
      : `${side.workspace_provisioning} (${side.workspace_provisioning_basis ?? 'basis not recorded'})`;

  return [
    `${label}requested:  ${side.requested_ref}`,
    `${label}observed:  ${side.observed_judged_commit ?? 'not observed'} (${side.requested_commit === side.observed_judged_commit ? 'matches the requested commit' : 'DOES NOT match the requested commit'})`,
    `         observed2: ${side.observed_judged_commit_post ?? 'not recorded'} — the SAME observation re-read after the gate; both samples must name the requested commit or this side decides nothing`,
    `         scope:       ${side.judged_commit_scope ?? 'unrecorded'} · run: ${side.run_id ?? '(no run)'} · ledger: not attached (regress never writes one)`,
    `         state:       ${side.state} — ${side.reason}`,
    `         workspace:   ${side.workspace_state ?? 'none'} (instance ${side.instance}, key ${side.workspace_key ?? 'n/a'})`,
    `         install:     ${side.workspace_install === null ? 'not recorded' : `${side.workspace_install.mode} -> ${side.workspace_install.outcome}${side.workspace_install.exit_code === null || side.workspace_install.exit_code === undefined ? '' : ` (exit ${side.workspace_install.exit_code})`}`} (the historical install; the evaluate run itself installs nothing)`,
    `         provisioning:${provisioning}`,
    `         state digest:${side.workspace_installed_state_digest ?? environment?.installed_state_digest ?? 'not recorded'} (${environment?.installed_state_digest_source ?? 'no record'} — declared by npm, not an independent observation of the bytes)`,
    `         tree digest: ${side.workspace_installed_tree_fingerprint ?? 'not recorded'} (${side.workspace_installed_tree_fingerprint_tier ?? 'no tier'} tier — OBSERVED by this program walking the tree; a different field from the state digest above, and never a substitute for it)`,
    `         build:       ${side.workspace_build_mode ?? 'not recorded'} -> ${side.workspace_build_outcome ?? 'not recorded'}; command: ${side.workspace_build_command ?? '(none — nothing needed building for this gate)'}`,
    `         build state: ${side.workspace_build_state_digest ?? 'not applicable (no build output required by this gate)'} — OBSERVED in the SOURCE tree by this program; a build EXECUTES the commit's own build string with no neutraliser, and its script execution is permanently null, never true`,
    `         environment: ${environment?.node?.version ?? '?'} · ${environment?.package_manager?.name ?? '?'} ${environment?.package_manager?.version ?? '?'} · ${environment?.platform === null || environment?.platform === undefined ? '?' : `${environment.platform.os}/${environment.platform.arch}`} · env ${environment?.env?.vars_digest ?? '?'} (${environment?.env?.count ?? '?'} vars)`,
    `         gate:        ${side.gate ?? '?'} -> ${side.gate_exit_code === null ? 'no result' : side.gate_exit_code === 0 ? 'PASS' : 'FAIL'}${side.failing_step === null || side.gate_exit_code === 0 ? '' : ` (aborted after ${side.failing_step})`}`,
    // Per-step mode, printed only when the side was measured per-step. UNDEFINED is named, not rendered as a failure.
    side.step_scope === null || side.step_scope === undefined
      ? null
      : `         step:        ${regressStepScopeBrief(side.step_scope)}`,
    `         resolver:     ${side.resolver_all_inside === null ? 'no probe recorded (this run bore no gate)' : `${environment.resolver_probe.length} probed, ${side.resolver_all_inside ? 'all resolved inside the worktree' : 'AT LEAST ONE RESOLVED OUTSIDE THE WORKTREE'}`}`,
    `         tree hashes: ${side.status_hash_pre ?? 'null'} -> ${side.status_hash_post ?? 'null'} — ${REGRESS_STATUS_HASH_SCOPE.is}; it ${REGRESS_STATUS_HASH_SCOPE.cannot_detect}`,
    `         acceptance:  ${side.acceptance_verdict ?? 'none'} (${side.acceptance_coverage_state ?? 'not mechanically evaluated'})`,
    `         gate env:    requested ${side.gate_env_policy_requested ?? 'not recorded'} -> OBSERVED ${side.gate_env_policy_observed ?? 'not recorded'}${side.gate_env_policy_requested === side.gate_env_policy_observed ? '' : ' (THE REQUESTED POLICY DID NOT REACH THE GATE)'}`,
    `         gate scripts:${regressGateScriptLines(side)}`,
    `         gate exec:   ${side.gate_execution === null ? 'not recorded (this side was never measured)' : `${side.gate_execution.digest} over ${side.gate_execution.gate} (${side.gate_execution.resolved_steps.length} resolved step(s) + ${side.gate_execution.invoked_script_definitions.length} script definition(s) read from this workspace's own manifests)`}`,
  ];
}

/** One line per script the gate invokes, as THIS judged commit defines it. R2: the neutered-gate case is visible here. */
function regressGateScriptLines(side) {
  const scripts = side.gate_execution?.invoked_script_definitions ?? [];

  if (scripts.length === 0) {
    return 'not recorded';
  }

  return scripts
    .map(
      (entry) =>
        `${entry.package_path ?? '(unknown manifest)'} :: ${entry.script ?? '(unknown script)'} = ${
          entry.defined === true ? JSON.stringify(entry.value) : `NOT DECLARED (${entry.reason ?? 'unknown'})`
        }`,
    )
    .join(' | ');
}

/**
 * P1: the repeated-evaluation block. Printed ONLY when N > 1, so an ordinary comparison's output is byte-for-byte what
 * it was before `--repeat` existed. Every line here is a NUMBER or a RULE; none of them is a guarantee, and the words
 * that would turn a number into a guarantee are deliberately absent from the whole block.
 */
function regressRepeatLines(aggregate, label) {
  if (aggregate === null) {
    return [];
  }

  const bound = aggregate.bound;
  const counts = aggregate.state_counts;
  const majority = aggregate.majority_not_taken;

  return [
    '',
    `  ${label} classification: ${aggregate.classification}  [rule: ${aggregate.classification_rule_id}]`,
    `  ${label} trials:        ${aggregate.trials_performed} performed / ${aggregate.trials_requested} requested - PASS ${counts.PASS} / FAIL ${counts.FAIL} / INCONCLUSIVE ${counts.INCONCLUSIVE} / ERROR ${counts.ERROR}`,
    `  ${label} majority:      NOT TAKEN - ${majority.available === true ? `${majority.votes_for_it} of ${aggregate.trials_performed} trials said ${majority.state} and ${majority.votes_needed} would have been enough, so a majority rule was available and was refused` : majority.tie === true ? `the trials TIED (${counts.PASS} PASS, ${counts.FAIL} FAIL), so a vote would have had to invent an outcome; the rule did not` : 'no majority was available; every trial said the same thing'}`,
    aggregate.direction_attainable === false
      ? `  *** ${label} UNATTAINABLE DIRECTION: a vote was available and was refused, so no bound can make a direction attainable here. At a flip rate near 0.5 the vote is wrong exactly half the time for EVERY N, whatever the number below says. More trials is not a remedy - the disagreement rule is.`
      : null,
    `  ${label} disagreeing:   k = ${aggregate.k} of ${aggregate.trials_performed} observations disagreed with the rest (observed flip rate ${aggregate.flip_rate_observed ?? 'n/a'})`,
    `  ${label} bound:         p <= ${bound.value ?? 'not computed'}   (one-sided ${bound.confidence}, ${bound.exact === true ? 'EXACT' : 'NOT exact - see the basis'})`,
    bound.exact !== true
      ? `  ${label} exactness:     NOT EXACT, and the record says so rather than shipping the number as if it were a root: ${bound.exactness_basis ?? 'no basis recorded'}`
      : typeof bound.tail_residual_at_bound === 'number'
        ? `  ${label} exactness:     the EXACT label is CHECKED, not asserted: re-evaluating the tail at the published bound gives a residual of ${bound.tail_residual_at_bound}, within this program's own ${REGRESS_TAIL_RESIDUAL_MAX} tolerance`
        : null,
    `  ${label} derivation:    ${bound.formula ?? 'not computed'}`,
    `  ${label} method:        ${bound.method ?? 'not computed'} (${bound.approximation ?? 'n/a'})`,
    `  ${label} at k=0:        ${bound.bound_at_zero_flips ?? 'n/a'} for the same N - ${bound.tightened_from_zero_flips === true ? 'THIS BOUND IS TIGHTER, which is the anti-conservative direction' : 'this bound is not tighter than the zero-flip bound for the same N'}`,
    `  ${label} exchangeability: assumed, unverified - what breaks it: a POSITIVELY CORRELATED defect (a warm/cold cache, a session-scoped resource, a first-run-only failure) or machine load. Under positive correlation these ${aggregate.trials_performed} trials are not ${aggregate.trials_performed} independent draws, so the bound above is not a bound on anything real and repetition buys nothing.`,
    bound.anti_conservative === true
      ? `  *** ${label} ANTI-CONSERVATIVE: observing a disagreement made this number TIGHTER than the zero-flip bound for the same N. WHAT THIS FLAG IS: an ARITHMETIC property of k >= 1 rather than a better answer and rather than a measured defect - an exact Clopper-Pearson limit at k=1 is already ~0.05/n, so essentially every ordinary disagreement fires it, INCLUDING a perfectly exchangeable p = 0.01 observation, and it does not distinguish an exchangeable run from a defective one. THE MEASURED EVIDENCE, separately: a commit failing only the first run of a session agreed 58/59 times in one block and failed 9/9 in the condition a boundary-search step actually runs in, with a byte-identical workspace attestation. That is what a single flip which tightens the number can be hiding. Read the histogram, not the bound.`
      : null,
    bound.unattainable_below_floor === true
      ? `  *** ${label} UNATTAINABLE: the requested bound cannot be reached at this observed flip rate for ANY N. At p ~ 0.5 no repetition count attains a bound below 0.5 and a majority vote there is wrong exactly half the time, so more trials is not a remedy - the disagreement rule is. Ask a different question rather than asking the same one more times.`
      : null,
    `  ${label} trials observed:`,
    ...aggregate.observations.map(
      (observation) =>
        `      #${observation.trial_index ?? '?'} ${observation.state}  run ${observation.run_id ?? 'none'}  commit ${observation.observed_judged_commit ?? 'not observed'}  gate exit ${observation.gate_exit_code ?? 'none'}`,
    ),
  ];
}

function cmdRegress(flags) {
  const goodRef = typeof flags.good === 'string' ? flags.good.trim() : null;
  const targetRef = typeof flags.target === 'string' ? flags.target.trim() : null;

  if (goodRef === null || goodRef === '') {
    fail('regress requires --good=<ref>');
  }

  if (targetRef === null || targetRef === '') {
    fail('regress requires --target=<ref>');
  }

  // The flag boundary, before the task lookup and before a single workspace exists. `regress` forwards this policy to
  // BOTH `evaluate` children and records it in the session binding, so an unrecognised value here would otherwise be
  // stamped into the artifact as a deliberate `sanitised` choice that nobody made.
  assertGateEnvFlagValue(flags, (refusal) => {
    fail(
      [
        `${refusal.name}: ${refusal.reason}`,
        ...refusal.lines,
        `exit: 2 (nothing was created, installed, prepared or measured)`,
      ].join('\n'),
    );
  });

  // The tier is the OTHER closed set this command inherits from `workspace prepare`, and it had the same hole in the
  // same direction: forwarded to two children and refused late, inside workspace preparation, in the WORKSPACE exit set —
  // a pre-evaluation event where the operator's own command line earned a command-local usage refusal. It fails closed
  // and it names the tier, so no measurement was ever wrong; the exit code was simply not the documented one.
  assertFingerprintFlagValue(flags, (refusal) => {
    fail(
      [
        `${refusal.name}: ${refusal.reason}`,
        ...refusal.lines,
        `exit: 2 (nothing was created, installed, prepared or measured)`,
      ].join('\n'),
    );
  });

  const taskId = typeof flags.task === 'string' ? flags.task : null;

  if (taskId === null) {
    fail('regress requires --task=<id> (a contract is the question both sides answer; it is never guessed)');
  }

  const task = findTask(taskId);
  const gateName = resolveGateName(flags, task);
  // PER-STEP MODE, resolved HERE and before anything else is built from it: the name is validated against the gate
  // definition, so an unknown step is refused before two installations. Whether the step is APPLICABLE is a different
  // question, answered per side by that side's own `evaluate` child against ITS prepared workspace.
  const regressStep = resolveStepFlag(flags, gateName);
  // `--step` reaches `workspace prepare` as well as `evaluate`, so the workspace's whole-gate refusal does not answer a
  // per-step question. Both sides are prepared under the same request, so the two attestations are comparable.
  const keep = flags.keep === true;
  // Both sides prepare and evaluate under the SAME explicitly recorded choices, so a comparison never mixes a workspace
  // attested at one fingerprint tier with a gate run under another environment policy.
  const extraFlags = {};
  const regressFingerprint = flags.fingerprint === undefined ? TREE_FINGERPRINT_DEFAULT_TIER : flags.fingerprint;
  const regressGateEnv = GATE_ENV_POLICIES.includes(flags['gate-env']) ? flags['gate-env'] : GATE_ENV_DEFAULT_POLICY;

  // P1 — `--repeat=N`, refused BY NAME before a single workspace exists when it is not a usable count. N = 1 is the
  // default and takes the pre-`--repeat` path unchanged, which is the backwards-compatibility anchor.
  const regressRepeat = resolveRepeatTrials(flags.repeat);
  const regressSession = resolveRepeatSession(flags['repeat-session']);
  // The step request reaches both `workspace prepare` (through `extraFlags`) and each side's `evaluate` child. No
  // second path: a comparison over a step, a repeated comparison over a step and a standalone per-step run all go
  // through the ONE `evaluate` and the ONE `classifyRegressSide`.
  if (regressStep !== null) {
    extraFlags.step = regressStep;
  }

  // Resolve BOTH refs before doing any work: the same-commit case is a refusal, and discovering it after two installs
  // would have spent two installations to learn that there was nothing to compare.
  const goodResolved = normalizeCommitSha(
    (git(['rev-parse', '--verify', `${goodRef}^{commit}`], REPO_ROOT) ?? '').trim(),
  );
  const targetResolved = normalizeCommitSha(
    (git(['rev-parse', '--verify', `${targetRef}^{commit}`], REPO_ROOT) ?? '').trim(),
  );

  if (goodRef === targetRef || (goodResolved !== null && goodResolved === targetResolved)) {
    printWorkspaceSummary([
      'regress:                same_commit_on_both_sides',
      `good:                   ${goodRef}${goodResolved === null ? ' (unresolved)' : ` -> ${goodResolved}`}`,
      `target:                 ${targetRef}${targetResolved === null ? ' (unresolved)' : ` -> ${targetResolved}`}`,
      'verdict:                not_a_comparison',
      'reason:                 --good and --target name the SAME commit, so there is nothing to compare. Reporting a',
      '                        comparison here would dress one observation up as a difference between two.',
      'exit:                   2 (command-local usage/refusal)',
      'note:                   no workspace was created, no gate ran, and no ledger was touched',
    ]);

    return REGRESS_EXIT_USAGE;
  }

  // R7: the `--out` target is checked BEFORE anything is measured. Discovering the refusal afterwards cost two real
  // installs and a cleanup before the command exited 2 with no comparison output at all. The path is resolved once
  // here and the resolved value is what gets written.
  let artifactOutPath = null;

  if (typeof flags.out === 'string') {
    try {
      artifactOutPath = resolveExternalOutputPath(flags.out);
    } catch (error) {
      printWorkspaceSummary([
        'regress:                out_path_refused',
        `--out:                  ${flags.out}`,
        `reason:                 ${String(error?.message ?? error)}`,
        'when:                   refused BEFORE any side was prepared, installed, measured or cleaned up — the refusal',
        '                        never costs an installation',
        'exit:                   2 (command-local usage/refusal)',
        'note:                   no workspace was created, no gate ran, and no ledger was touched',
      ]);

      return REGRESS_EXIT_USAGE;
    }
  }

  // R5: one identity for THIS invocation. Two concurrent comparisons of the same pair used the same fixed instance
  // labels and therefore the same two deterministic directories; one destroyed the other and the loser was reported
  // `cannot_compare` for a collision that had nothing to do with either commit.
  const invocationId = regressInvocationId();
  // P1: the trial log is named by the SESSION, and only a caller-supplied `--repeat-session` can resume one. A fresh
  // invocation therefore always gets a fresh log, and two concurrent comparisons never share one.
  const sessionId = regressSession ?? invocationId;
  const trialsLogPath = regressTrialsLogPath(sessionId);
  const trialsLogHeadPath = regressTrialsLogHeadPath(sessionId);
  // B1. The token is now a NAME for one comparison, not a name for "some trials". Everything that decides what a
  // measured trial MEANS is bound into a digest, and a replay against a different pair is refused by name.
  const sessionBinding = regressSessionBinding({
    taskId: task.id,
    gateName,
    goodRef,
    goodCommit: goodResolved,
    targetRef,
    targetCommit: targetResolved,
    gateEnvPolicy: regressGateEnv,
  });

  // B8. Concurrency is DETECTED rather than locked, for a measured reason recorded in REPLAY_CONCURRENCY_BASIS. The
  // detection happens twice: once on READ (a duplicate trial index or a broken chain in what an earlier run left) and
  // once on the appends THIS invocation just made, so a collision that gets as far as writing is still refused by name
  // instead of producing a verdict derived from interleaved measurements.
  return runRegressComparison({
    goodRef,
    targetRef,
    goodResolved,
    targetResolved,
    task,
    gateName,
    keep,
    extraFlags,
    regressFingerprint,
    regressGateEnv,
    regressRepeat,
    regressSession,
    regressStep,
    invocationId,
    sessionId,
    sessionBinding,
    trialsLogPath,
    trialsLogHeadPath,
    artifactOutPath,
    flags,
  });
}

/** Everything `cmdRegress` does once the comparison's identity is bound. */
function runRegressComparison(context) {
  const {
    goodRef,
    targetRef,
    task,
    gateName,
    keep,
    extraFlags,
    regressFingerprint,
    regressGateEnv,
    regressRepeat,
    regressSession,
    regressStep,
    invocationId,
    sessionId,
    sessionBinding,
    trialsLogPath,
    trialsLogHeadPath,
    artifactOutPath,
    flags,
  } = context;
  const replayedTrials = new Map();

  // B3 + B8. The verified read. It returns the rows AND the chain verdict together, so there is no path in this
  // program that reads trial rows without also being told whether the chain holds.
  const logRead = regressReadTrialLogVerified(trialsLogPath, { headPath: trialsLogHeadPath });
  const chain = logRead.chain;

  // B3 + B8. Refusals, by name, before a single workspace exists. Each one names what was wrong and what would be
  // right; none of them emits a verdict, because a verdict here would be a direction derived from bytes nobody checked.
  const refusal = regressReplayRefusal({ logRead, sessionBinding, regressSession });

  if (refusal !== null) {
    printWorkspaceSummary([
      `regress:                ${refusal.refusal.toLowerCase()}`,
      `refusal:               ${refusal.refusal}`,
      `session:               ${sessionId}`,
      ...refusal.lines.map((line) => `                        ${line}`),
      'when:                  refused BEFORE any side was prepared, installed, measured or cleaned up — the refusal',
      '                        never costs an installation',
      'exit:                  2 (command-local usage/refusal)',
      'note:                  no workspace was created, no gate ran, NO VERDICT WAS EMITTED and no ledger was touched',
      ...REPLAY_REFUSALS.map((line) => `limitation:             ${line}`),
    ]);

    return REGRESS_EXIT_USAGE;
  }

  for (const entry of logRead.entries) {
    if (Number.isInteger(entry.trial_index) && !replayedTrials.has(entry.trial_index)) {
      replayedTrials.set(entry.trial_index, entry);
    }
  }

  const goodTrials = [];
  const targetTrials = [];
  const trialProvenance = [];
  // ORDER-AWARE SCHEDULING. The old loop ran good-then-target in every trial, so an order-coupled defect was
  // CONSISTENT BETWEEN the sides and the contradiction rule could never fire. The schedule rotates the first
  // position per trial, so such a defect now has to disagree with ITSELF. At N = 1 the schedule is the single block
  // `['good', 'target']` — byte-for-byte the pre-`--repeat` order — and nothing else about the run changes.
  const executionOrder = regressExecutionOrder(regressRepeat);

  try {
    for (let trialIndex = 0; trialIndex < regressRepeat; trialIndex += 1) {
      // A trial an earlier invocation already COMPLETED is replayed, not re-run and not rewritten: the log is
      // append-only, and an interrupted run loses nothing it had already measured. What it must NOT be is TRUSTED —
      // every replayed side is re-derived from the run stream it names before it is allowed near the aggregate.
      const replayed = replayedTrials.get(trialIndex) ?? null;

      if (replayed !== null) {
        const goodSide = withTrialVerification(replayed.sides?.good ?? null, 'good');
        const targetSide = withTrialVerification(replayed.sides?.target ?? null, 'target');

        goodTrials.push(goodSide);
        targetTrials.push(targetSide);
        trialProvenance.push({
          trial_index: trialIndex,
          order: executionOrder.schedule[trialIndex],
          source: 'replayed_from_trial_log',
          run_ids: [goodSide?.run_id ?? null, targetSide?.run_id ?? null],
          verified: { good: goodSide?.verified ?? null, target: targetSide?.verified ?? null },
          verification_reason: {
            good: goodSide?.verification_reason ?? null,
            target: targetSide?.verification_reason ?? null,
          },
        });
        continue;
      }

      // The roles are collected into a MAP and then executed in the scheduled order, so the order is a property of
      // the SCHEDULE rather than of the source line the two calls happen to sit on. That is the whole point: the old
      // code hard-coded good-then-target into the call order, which is why a defect correlated with that order was
      // invisible. `measured` is keyed by role, so `goodTrials`/`targetTrials` are still in TRIAL-INDEX order.
      const measured = {};
      const roles = { good: goodRef, target: targetRef };

      for (const role of executionOrder.schedule[trialIndex]) {
        measured[role] = regressRunSide({
          role,
          ref: roles[role],
          task,
          gateName,
          extraFlags,
          fingerprintTier: regressFingerprint,
          invocationId,
          gateEnvPolicy: regressGateEnv,
          trialIndex,
          stepName: regressStep,
        });
      }

      const goodTrial = measured.good;
      const targetTrial = measured.target;

      // A trial THIS invocation measured is verified by construction: the process that produced it is still running and
      // still holds the values. Only a REPLAYED trial can be unverified.
      for (const trial of [goodTrial, targetTrial]) {
        trial.verified = true;
        trial.verification_basis = 'measured_by_this_invocation: the process that produced this trial is this one';
        trial.verification_reason = null;
        trial.verification_checked = ['measured_by_this_invocation'];
      }

      goodTrials.push(goodTrial);
      targetTrials.push(targetTrial);
      trialProvenance.push({
        trial_index: trialIndex,
        order: executionOrder.schedule[trialIndex],
        source: 'measured_by_this_invocation',
        run_ids: [goodTrial.run_id, targetTrial.run_id],
        verified: { good: true, target: true },
        verification_reason: { good: null, target: null },
      });

      // Durability: fsynced as each trial COMPLETES, not at the end. A kill between trials therefore leaves every
      // completed trial on disk, and the next invocation reads them instead of repeating the work.
      appendRegressTrialEntry(
        trialsLogPath,
        {
          schema_version: REPEAT_TRIALS_LOG_SCHEMA_VERSION,
          session_id: sessionId,
          trial_index: trialIndex,
          at: new Date().toISOString(),
          task_id: task.id,
          gate: gateName,
          invocation_id: invocationId,
          repeat_requested: regressRepeat,
          gate_env_policy_requested: regressGateEnv,
          requested: { good: goodRef, target: targetRef },
          session_binding: sessionBinding,
          // Additive: the ORDER this trial's two sides were measured in. A resumed session reads it back, so a replayed
          // trial is reported under the position it was measured under rather than a fresh one.
          order: executionOrder.schedule[trialIndex],
          sides: { good: goodTrial, target: targetTrial },
        },
        { headPath: trialsLogHeadPath },
      );
    }
  } catch (error) {
    // B6. The byte bound refuses the append, names itself, and the comparison is `cannot_compare` rather than a
    // direction derived from a trial set the log could not record.
    if (error?.code === 'TRIAL_LOG_BYTE_BOUND_EXCEEDED') {
      printWorkspaceSummary([
        'regress:                trial_log_byte_bound_exceeded',
        `refusal:               TRIAL_LOG_BYTE_BOUND_EXCEEDED`,
        `session:               ${sessionId}`,
        `reason:                ${String(error?.message ?? error)}`,
        'verdict:               cannot_compare',
        // F6: the label names BOTH situations exit 5 covers, and the `reason:` line above names THIS one, so the
        // printed number and the manual cannot contradict each other.
        `exit:                  ${REGRESS_EXIT_INCONCLUSIVE} (command-local; ${REGRESS_EXIT_FIVE_BASIS})`,
        ...REPLAY_REFUSALS.map((line) => `limitation:             ${line}`),
      ]);

      return REGRESS_EXIT_INCONCLUSIVE;
    }

    throw error;
  }

  // P1: `sides` is the OBSERVATION structure and never a summary. At N = 1 it is exactly what it has always been; at
  // N > 1 it is trial 0, and every trial — including trial 0 — is also in `trials` and in the append-only log.
  const good = goodTrials[0];
  const target = targetTrials[0];
  const aggregates =
    regressRepeat === 1
      ? null
      : {
          good: classifyRegressTrials(goodTrials, regressRepeat),
          target: classifyRegressTrials(targetTrials, regressRepeat),
        };
  // The pair-decision inputs. At N = 1 these ARE the observation objects, so the direction lookup runs on exactly what
  // it has always run on; at N > 1 they are derived from the aggregate and carry the trials with them.
  const goodDecision = aggregates === null ? good : regressAggregateDecisionSide('good', aggregates.good, good);
  const targetDecision =
    aggregates === null ? target : regressAggregateDecisionSide('target', aggregates.target, target);
  const environment = compareRegressEnvironments(good, target);
  // B5. The SAME comparison over every trial, not trial 0 alone, and a MATERIAL field that varies WITHIN a side is a
  // contradiction that makes both sides INCONCLUSIVE — the same rule that governs a flipped trial state, applied to the
  // environment the trials ran in.
  const environmentAcrossTrials = compareRegressEnvironmentsAcrossTrials(goodTrials, targetTrials);
  const confirmation =
    flags['confirm-disagreement'] === true
      ? regressConfirmDisagreement({ good, target, gateName, gateEnvPolicy: regressGateEnv })
      : null;

  // The contract's DECLARED commit and the OBSERVED commits are printed side by side, each labelled, exactly as
  // `ledger show` does. They are never merged: a declaration is a diff base, not a statement about what was executed.
  // P1: a digest or gate that is not the SAME across every trial is itself a contradiction, so the test is over the set
  // of values all N trials of both sides produced — which reduces to the pre-`--repeat` condition when N = 1.
  const allTrials = [...goodTrials, ...targetTrials];
  const distinct = (read) => new Set(allTrials.map(read).filter((value) => value !== null && value !== undefined));
  const contractDigestDiffers = distinct((trial) => trial.contract_digest).size > 1;
  const gateDiffers = distinct((trial) => trial.gate).size > 1;
  // B5. A cross-trial environment contradiction is a third way for the two sides not to have answered the same
  // question, and it joins the other two rather than being reported beside them and then ignored.
  const environmentContradiction = environmentAcrossTrials.contradiction === true;
  const inputDisagreementReason = environmentContradiction
    ? `the trials of this comparison did not all observe the same environment: ${environmentAcrossTrials.contradiction_fields.join('; ')} varies WITHIN a side, so the sides did not answer the same question`
    : 'the two sides answered different questions';
  const direction =
    contractDigestDiffers || gateDiffers || environmentContradiction
      ? applyBasis(
          compareRegressSidesDirection(
            { ...goodDecision, state: 'INCONCLUSIVE', reason: inputDisagreementReason },
            { ...targetDecision, state: 'INCONCLUSIVE', reason: inputDisagreementReason },
          ),
          regressRepeat,
        )
      : applyBasis(compareRegressSidesDirection(goodDecision, targetDecision), regressRepeat);
  // R1: a contradicting second observation WITHDRAWS the direction. It never asserts one, and a confirmation that
  // AGREED with the comparison leaves the decision byte-identical.
  const confirmed = applyRegressConfirmation(direction, confirmation);

  const cleanup = keep
    ? { performed: false, reclaimed_bytes: 0, removed: [], failures: [], note: 'retained (--keep)' }
    : regressReclaimInstances([...goodTrials, ...targetTrials]);

  // R4: resolved ONCE, before anything is written or printed, and the report prints exactly this number.
  const resolvedExit = resolveRegressExitCode({
    comparisonExitCode: confirmed.exit_code,
    cleanupFailures: cleanup.failures.length,
  });
  // R2: the gate-execution disclosure travels WITH the verdict, so a reader of the artifact alone cannot see an
  // unqualified direction over two sides that did not run the same gate.
  const verdictDisclosures = environment.gate_execution.prominent ? [environment.gate_execution.disclosure] : [];
  const artifact = {
    schema_version: REGRESS_ARTIFACT_SCHEMA_VERSION,
    kind: REGRESS_ARTIFACT_KIND,
    at: new Date().toISOString(),
    task_id: task.id,
    gate: gateName,
    invocation_id: invocationId,
    gate_env_policy_requested: regressGateEnv,
    // PER-STEP MODE. Additive, and present (with `requested: null`) on every comparison so a reader never has to
    // distinguish "not recorded" from "not applicable". `requested` is what the operator asked for; each SIDE's own
    // answer lives in `sides.<role>.step_scope`, read back from that side's run stream, because whether a step is
    // applicable is a property of the JUDGED COMMIT's manifests and the two commits can disagree about it.
    step_scope: {
      requested: regressStep,
      gate: gateName,
      per_side_answer: { good: good.step_scope ?? null, target: target.step_scope ?? null },
      undefined_basis: STEP_SCOPE_UNDEFINED_BASIS,
      composes_with: [
        'workspace prepare — the applicability question is answered inside the prepared worktree, against the judged commit manifests, with the full workspace attestation in place',
        'regress --repeat — each trial is one more per-step run and is classified by the same classifyRegressSide; the order rotation and the contradiction rule are unchanged',
      ],
      no_second_ledger:
        'per-step mode adds NO ledger, NO workspace implementation and NO provenance format: it selects which steps the EXISTING evaluate loop runs, and a per-step run does not update the attached ledger at all (step_scope.ledger_effect in each run).',
    },
    declared_source_commit: task.source_commit,
    requested: { good: goodRef, target: targetRef },
    sides: { good, target },
    verdict: confirmed.verdict,
    verdict_reason: confirmed.reason,
    verdict_basis: confirmed.verdict_basis,
    verdict_basis_text: confirmed.verdict_basis_text,
    observations_per_side: confirmed.observations_per_side,
    confirmation_withdrawal: confirmed.confirmation_withdrawal,
    withdrawal: confirmed.withdrawal,
    verdict_disclosures: verdictDisclosures,
    comparison_exit_code: direction.exit_code,
    exit_code: resolvedExit.exit_code,
    exit_precedence: {
      ...resolvedExit.rule,
      cleanup_refused: resolvedExit.cleanup_refused,
      raised_by_cleanup: resolvedExit.raised_by_cleanup,
      printed_exit_equals_process_exit: true,
    },
    environment_comparison: environment,
    // B5. The all-trials comparison, beside the trial-0 one it corrects. At N = 1 the two agree by construction.
    environment_comparison_across_trials: environmentAcrossTrials,
    // P4: what `status_hash_pre`/`status_hash_post` are and are not, in the artifact, so a reader of the JSON alone
    // cannot read a `tree_moved` decision as a tree-identity fact.
    status_hash_scope: REGRESS_STATUS_HASH_SCOPE,
    confirm_disagreement: confirmation,
    cleanup,
    non_causal:
      'this artifact is additive and read by no decision path: regress attaches no ledger, appends no evaluations[]/environments[]/verification[] entry, and sets no status. It enters no denominator in any LEDGER-derived denominator. It is NOT invisible in `report`: each side is an ordinary gate-bearing evaluate run, so `report` counts both and discloses them under comparison_sourced_runs (see REGRESS_RUN_ORIGIN_KIND).',
    limitations: REGRESS_LIMITATIONS,
    // P1 — repeated evaluation. ADDITIVE ONLY: every field below is new, `sides` above is unchanged, and at N = 1 the
    // whole repeat block is a description of the single observation that already decided the verdict.
    repeat: {
      requested: regressRepeat,
      default: REPEAT_DEFAULT_TRIALS,
      max_trials: REPEAT_MAX_TRIALS,
      confidence: REPEAT_CONFIDENCE,
      rule_id: REPEAT_RULE_CONTRADICTION,
      rule: REPEAT_CLASSIFICATION_RULE,
      vote_used: false,
      vote_forbidden: REPEAT_VOTE_FORBIDDEN,
      rule_ids: REPEAT_RULE_IDS,
      performed: { good: goodTrials.length, target: targetTrials.length },
      complete: goodTrials.length === regressRepeat && targetTrials.length === regressRepeat,
      non_resolving: REPEAT_NON_RESOLVING,
      bound_is_not_a_licence: REPEAT_BOUND_NOT_A_LICENCE,
      per_side: aggregates === null ? null : { good: aggregates.good, target: aggregates.target },
      // ORDER-AWARE. Additive, and recorded at EVERY N including N = 1 — at N = 1 it describes the single block that
      // is byte-for-byte the pre-`--repeat` order, which is what makes "N = 1 is unchanged" a checkable field rather
      // than a promise. `is_legacy_order` is the negative control: a reader can confirm the design is not the old one
      // without taking this program's word for it.
      execution_order: executionOrder,
      // A DISCLOSURE, explicitly `classification_input: false`. See REGRESS_ORDER_RESIDUAL for why this is reported
      // rather than turned into a second classification path.
      position_conditional: regressPositionConditionalStates(executionOrder, goodTrials, targetTrials),
      limitations: REPEAT_LIMITATIONS,
    },
    // P1 — every trial, preserved. `trials` is the OBSERVATION record and `repeat.per_side` is the AGGREGATE; the two
    // are separate structures and neither overwrites the other. A reader can rebuild the full distribution from here
    // without re-running anything.
    trials: { good: goodTrials.map(regressTrialRecord), target: targetTrials.map(regressTrialRecord) },
    trials_full: { good: goodTrials, target: targetTrials },
    trial_provenance: trialProvenance,
    trials_log: {
      path: relative(trialsLogPath),
      session_id: sessionId,
      schema_version: REPEAT_TRIALS_LOG_SCHEMA_VERSION,
      // These two are KEPT because the record has always carried them, and their scope is now stated rather than left
      // to be inferred. They describe this program's own writes and are backed by the chain below, not asserted bare.
      append_only: true,
      rewritten: false,
      append_only_scope: REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE,
      entries_on_disk: chain.entries,
      entries_verified: chain.verified_entries,
      entries_written_by_this_invocation: trialProvenance.filter(
        (entry) => entry.source === 'measured_by_this_invocation',
      ).length,
      entries_replayed: trialProvenance.filter((entry) => entry.source === 'replayed_from_trial_log').length,
      resumable: true,
      // B1. What this session is bound to, and the digest that binding produced. A token names ONE comparison.
      session_binding: sessionBinding,
      // B3. The chain verdict, read at the same time the rows were read, so no reader can see a row without it.
      chain,
      // B6. The bound that is actually enforced, next to the count bound it is not.
      byte_bound: {
        max_bytes: REPEAT_TRIALS_LOG_MAX_BYTES,
        enforced: true,
        basis: REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS,
        bytes_now: chain.bytes ?? null,
        max_trials_count_bound: REPEAT_MAX_TRIALS,
        max_trials_is_a_count_not_a_byte_bound: true,
      },
      note: 'an interrupted run loses no completed trial: each trial is fsynced to this log as it completes, and a later --repeat-session=<token> replays the completed trials instead of re-running or rewriting them',
      trust_scope: REPLAY_TRUST_SCOPE,
    },
    // B2. The verification verdicts, as an aggregate a reader cannot miss. `unverified_trials > 0` means the side is not
    // classifiable from those trials, and the aggregate is INCONCLUSIVE rather than a direction.
    trial_verification: {
      unverified_trials:
        aggregates === null
          ? { good: 0, target: 0 }
          : {
              good: aggregates.good.unverified_trials,
              target: aggregates.target.unverified_trials,
            },
      classifiable:
        aggregates === null ? true : { good: aggregates.good.classifiable, target: aggregates.target.classifiable },
      basis:
        'a trial measured by this invocation is verified by construction; a trial REPLAYED from the log is verified only after its recorded gate exit and judged commit were re-read from the run stream it names and its recorded state was re-derived from them. An unverified trial makes its side INCONCLUSIVE and is never averaged away.',
      trust_scope: REPLAY_TRUST_SCOPE,
    },
    replay_refusal_names: REPLAY_REFUSAL_NAMES,
  };

  // The chain is RE-READ after the appends, so the artifact describes the log as it now is rather than as it was when
  // this invocation started. This invocation's own appends are therefore verified by the same routine that verifies a
  // log it did not write.
  const chainAfter = regressReadTrialLogVerified(trialsLogPath, { headPath: trialsLogHeadPath }).chain;

  // B8. THE POST-APPEND DETECTION. A collision can reach the append — two invocations both read "0 rows" and both write
  // `chain.index: 0` — and the pre-write gate cannot see it, because it ran before either row existed. The appends this
  // invocation just made are therefore re-read and checked with the same routine, and a collision is REFUSED here
  // rather than being reported as a comparison. The pre-fix behaviour was the opposite and worse in both directions: the
  // two runs both exited cleanly and the replay silently kept the first entry per index.
  if (chainAfter.verified !== true || chainAfter.duplicate_trial_indices.length > 0) {
    const collision = chainAfter.duplicate_trial_indices.length > 0 ? REPLAY_REFUSAL_DUPLICATE : REPLAY_REFUSAL_CHAIN;

    printWorkspaceSummary([
      `regress:                ${collision === REPLAY_REFUSAL_DUPLICATE ? 'duplicate_trial_index' : 'trial_log_chain_broken'}`,
      `refusal:               ${collision}`,
      `session:               ${sessionId}`,
      `entries on disk:       ${chainAfter.entries}`,
      `entries trusted:       ${chainAfter.verified_entries}`,
      `duplicate indices:     ${chainAfter.duplicate_trial_indices.length}`,
      `chain break:           ${chainAfter.break_reason ?? 'none'}`,
      `head:                  ${chainAfter.head_reason ?? 'agrees'}`,
      'reason:                two concurrent --repeat runs on one --repeat-session wrote into one log, and this comparison',
      '                        will NOT be derived from interleaved measurements. The collision is detected and refused;',
      '                        it is never resolved by keeping the first entry per index.',
      `basis:                 ${REPLAY_CONCURRENCY_BASIS}`,
      'when:                  refused AFTER the trials were measured and BEFORE any verdict was derived, printed or',
      '                        written; the workspaces are still reclaimed by the ordinary cleanup path',
      'exit:                  2 (command-local usage/refusal)',
      'note:                  NO VERDICT WAS EMITTED and no ledger was touched',
      ...REPLAY_REFUSALS.map((line) => `limitation:             ${line}`),
    ]);

    return REGRESS_EXIT_USAGE;
  }

  artifact.trials_log.entries_on_disk = chainAfter.entries;
  artifact.trials_log.entries_verified = chainAfter.verified_entries;
  artifact.trials_log.chain = chainAfter;
  artifact.trials_log.byte_bound.bytes_now = chainAfter.bytes ?? null;

  const artifactPath = writeRegressArtifact(artifactOutPath, artifact, invocationId);

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } else {
    printRegressReport({
      good,
      target,
      comparison: confirmed,
      environment,
      confirmation,
      cleanup,
      task,
      gateName,
      artifactPath,
      keep,
      exitCode: resolvedExit.exit_code,
      exitResolution: resolvedExit,
      repeat: {
        requested: regressRepeat,
        aggregates,
        trials: { good: goodTrials, target: targetTrials },
        sessionId,
        trialProvenance,
        environmentAcrossTrials,
        chain,
        sessionBindingDigest: sessionBinding.binding_digest,
        trialsTotal: goodTrials.length + targetTrials.length,
        unverifiedCount: [...goodTrials, ...targetTrials].filter((trial) => trial.verified === false).length,
        unverifiedLines: [...goodTrials, ...targetTrials]
          .filter((trial) => trial.verified === false)
          .map(
            (trial) =>
              `  UNVERIFIED:           trial ${String(trial.trial_index ?? '?')} (${trial.role}) — ${trial.verification_reason}${trial.verification_detail === null || trial.verification_detail === undefined ? '' : `: ${trial.verification_detail}`}`,
          ),
        executionOrder,
        positionConditional: regressPositionConditionalStates(executionOrder, goodTrials, targetTrials),
        stepScope: regressStep,
      },
    });
  }

  return resolvedExit.exit_code;
}

// ---------------------------------------------------------------- history census — failure regions, never one named commit
//
// WHY A NEW COMMAND AND NOT A FLAG ON `regress`. `regress` answers ONE question about TWO NAMED commits: did a
// difference appear BETWEEN them. A census answers a different question about a RANGE: what does the matrix over every
// commit in that range look like, where are the failure regions, and which commits sit at the observed transitions.
// Those have different inputs, a different artifact, a different vocabulary (`regions`, `candidates`, `observed
// transitions`, `monotonicity`) and their own exit set, so folding them into a flag would have meant a flag whose
// meaning changes with the other flags present. What it must NOT have meant is a second implementation, and it did not:
// the per-commit measurement IS `regressRunSide` — the same `workspace prepare`, the same `evaluate --step` child, the
// same `classifyRegressSide`, the same run stream, the same environment record, the same installed-tree fingerprints,
// the same `build_state` — and the durable row IS `appendRegressTrialEntry`, so there is one trial-log format, one digest
// chain and one reader. What is new here is only the DERIVATION over a matrix, and it is a pure function of that matrix.
//
// IT IS NOT A SEARCH. It enumerates exactly the commits `--from`..`--to` names and reports every one of them. It never
// narrows, never halves, never selects a midpoint, never proposes a next commit to measure and never emits a "first bad
// commit". A search is exactly the operation whose result the measured non-monotonicity here forbids, and `git bisect`
// stays a recorded NO-GO with no command, no flag and no stub. If a range is too expensive, the OPERATOR narrows it by
// hand; the refusal below names the bound and stops, because a tool that quietly measured less than it was asked to
// would be reporting on a range nobody chose.
//
// A CANDIDATE IS A CANDIDATE. The commit at a PASS->FAIL boundary is named `candidate` in the field, in the artifact, in
// the report and in the docs — never a `cause`, never a `responsible` field. A transition is not a cause: a
// candidate can be the boundary and still be innocent, which is precisely why a non-monotone history yields regions and
// candidates and a refusal, and never one named commit.

// The per-commit state vocabulary. FOUR of the five come straight out of `classifyRegressSide`; `UNDEFINED` is the
// Phase-1 per-step state REFUNDED to its own name rather than folded into INCONCLUSIVE, because "the judged commit's own
// manifests declare no such script" and "the tool could not decide" are different facts and a census that merged them
// would report a historical commit as undecidable for a reason that has nothing to do with it.
const CENSUS_STATES = ['PASS', 'FAIL', 'UNDEFINED', 'INCONCLUSIVE', 'ERROR'];

/**
 * THE UNDECIDED STATES, as their own list. A hole is a commit that was measured but not DECIDED: nothing was observed at
 * it, so it can neither continue a run of observed failures nor break one. `PASS` is the only state that closes a
 * failure region, and that single fact is what `censusRegions`, `censusMonotonicity` and `censusCandidates` are built on.
 * `UNDEFINED` is IN here on purpose and is never thereby a FAIL.
 */
const CENSUS_HOLE_STATES = ['UNDEFINED', 'INCONCLUSIVE', 'ERROR'];

/**
 * The command-local exit set. `3` is NEVER emitted, mirroring `regress`, and none of these is an `evaluate` exit code.
 *
 *   0  the range was enumerated and contains NO failure region (the monotonicity verdict is MONOTONE or UNDETERMINED)
 *   1  at least one FAILURE REGION — a finding about a range, never a direction about a single commit
 *   2  usage / refused, always BEFORE any measurement (a range that is not an ancestor path, an over-long range, a step
 *      name outside the gate, an `--out` path that escapes, a resumed session asking a different question)
 *   4  at least one commit is ERROR — a statement about THIS PROGRAM, not about the history
 *   5  the monotonicity verdict is UNDETERMINED: some commit in the range is UNDEFINED or INCONCLUSIVE, so no verdict
 *      over the range may be printed in either direction
 *
 * PRECEDENCE, mirroring `compareRegressSides` exactly: 4 outranks 5 outranks 1. A tool that could not do its job (4)
 * outranks a statement about the history (5), which outranks a finding (1). No new code was minted for a refused
 * removal: a cleanup refusal is DISCLOSED beside the census's own code and never demotes it, which is the same
 * precedence rule `regress` already documents for a finding.
 */
const CENSUS_EXIT_NO_FINDING = 0;
const CENSUS_EXIT_FINDING = 1;
const CENSUS_EXIT_USAGE = 2;
const CENSUS_EXIT_COMMIT_ERROR = 4;
const CENSUS_EXIT_UNDETERMINED = 5;
const CENSUS_EXIT_RULE = {
  rule: 'an ERROR commit (4) outranks an UNDETERMINED range (5), which outranks a finding (1); a refused removal is disclosed beside the code it did not replace and never demotes it; the printed exit IS the process exit',
  order: ['ERROR', 'UNDETERMINED', 'FINDING'],
  error_outranks_undetermined: true,
  undetermined_outranks_finding: true,
  cleanup_refusal_never_demotes: true,
  printed_exit_equals_process_exit: true,
  code_3_never_emitted: true,
  is_an_evaluate_exit_code: false,
  // ...and the two statements above are NOT the same claim, so the record carries both. `is_an_evaluate_exit_code: false` is
  // true of the SET: the census publishes {0,1,2,4,5} and the evaluate protocol does not. It OVERSTATES if read as a claim
  // that no number collides, and two do: census `0` and `2` are numerically identical to evaluate's, with different
  // meanings. The real discriminator is structural, and it is stated here rather than left to a reader who compares two
  // numbers: `3` is emitted by the evaluate protocol and NEVER by this command, and this command writes NO LEDGER at all.
  evaluate_numeric_overlap: [0, 2],
  evaluate_numeric_overlap_is_not_identity:
    'census 0 and census 2 are numerically identical to evaluate 0 and evaluate 2 and mean different things. The discriminator is structural, not numerical: `3` is an evaluate code and is NEVER emitted here, and this command attaches no ledger, appends no evaluations[]/environments[]/verification[] entry and sets no status, so no code of it can be read as a task outcome.',
  exit_3_never_emitted_by_either_command: true,
  no_ledger_is_written: true,
};
const CENSUS_EXIT_BASIS = {
  // The 0 text used to say "MONOTONE or UNDETERMINED", which was stale: an UNDETERMINED range ALWAYS yields 5, by the
  // precedence above, so a 0 is reachable only with a MONOTONE verdict and no region. Stating the reachable condition
  // makes the number and the manual unable to disagree.
  0: 'the range was enumerated in full, no commit is ERROR, the monotonicity verdict is MONOTONE, and it contains no FAILURE REGION. UNDETERMINED is NOT among the conditions that produce a 0: by the documented precedence an UNDETERMINED range always yields 5. A 0 is a statement about this MEASURED RANGE and about this STEP; it is not a claim about the repository, about any commit outside the range, or about any other step.',
  1: 'at least one failure region exists inside the MEASURED RANGE. A region is a finding about a range — it is NOT a direction about one commit, and this command never names one commit as the responsible party.',
  2: 'usage or refusal, always decided BEFORE any workspace was prepared, installed, built or measured. A refusal spends no installation and prints no verdict.',
  4: 'at least one commit in the range is ERROR: a HARNESS/OPERATIONAL failure, meaning this program could not run that commit to completion. It is a statement about the tool, not about the history, and it outranks every history-level statement here.',
  5: 'the monotonicity verdict is UNDETERMINED because at least one commit in the range is UNDEFINED or INCONCLUSIVE. A range with a hole in it has no verdict, and this command prints no verdict in either direction rather than guessing past the hole.',
};

/** A refusal is always structured, never a bare string, so a caller can read the reason without parsing prose. */
const CENSUS_REFUSAL_NAMES = [
  'not_an_ancestor_path',
  'range_too_long',
  'unknown_step',
  'out_path_refused',
  'census_session_rebound',
  'census_session_chain_broken',
  'census_trial_log_byte_bound',
  // Refused AT THE FLAG BOUNDARY, by name, before any workspace exists — the same treatment `--step` and
  // `--census-session` already get. An unrecognised `--fingerprint` tier used to survive the whole flag parse and fail
  // closed DEEP INSIDE workspace preparation with a generic `installed_tree_fingerprint_unavailable` refusal, which reads
  // as a measurement failure rather than as a typo. An unrecognised `--gate-env` used to fall back to `sanitised` in
  // silence: the safe direction, and still undocumented, which means a reader of the record cannot tell a deliberate
  // policy from a misspelled one.
  'unknown_fingerprint_tier',
  'unknown_gate_env_policy',
];

/**
 * THE MONOTONICITY VERDICT IS ABOUT THE MEASURED RANGE AND NOTHING ELSE. The word `range` is in the field name
 * (`monotonicity.scope`) precisely because a reader who sees `verdict: MONOTONE` must be able to check, without asking,
 * what it was a verdict about. The three outcomes, and the order they are decided in:
 *
 *   NOT_MONOTONE   at least one observed FAIL->PASS REVERSAL, or more than one disjoint failure region. Decided FIRST
 *                  and on its own evidence: a reversal is a fact that was observed inside the range, and a hole
 *                  elsewhere in the range does not un-observe it.
 *   UNDETERMINED   no reversal, but at least one commit is UNDEFINED, INCONCLUSIVE or ERROR. A gap is a gap.
 *   MONOTONE       every commit decided, no reversal, and at most one region which — if there is one — runs to the end
 *                  of the range.
 *
 * The `has_reversal` check is STRUCTURAL: it runs before the gap check, and `MONOTONE` is unreachable while
 * `has_reversal` is true. There is no flag that turns that off.
 */
const CENSUS_MONOTONICITY_STATES = ['MONOTONE', 'NOT_MONOTONE', 'UNDETERMINED'];
const CENSUS_MONOTONICITY_SCOPE = 'measured_range_only';
const CENSUS_MONOTONICITY_BASIS =
  'the verdict describes ONE MEASURED RANGE, for ONE STEP, under ONE environment policy, as observed by THIS program on THIS machine. It says nothing about commits outside the range, nothing about any other step, and nothing about the same range measured by anyone else. A range can be MONOTONE here and non-monotone one commit earlier, which is why the range is named in the record rather than left to the reader to reconstruct.';

/** `carries_no_information` is a separate, honest disclosure: a step that PASSES at every commit cannot localise anything. */
const CENSUS_NO_INFORMATION_BASIS =
  'every commit in the measured range PASSED, so this step separates nothing from anything: it is MONOTONE in the trivial sense that a constant series is monotone, and it localises NO boundary because there is no failure to localise. A MONOTONE verdict on an all-PASS step carries no information about the history and must not be read as a clean bill of health for the step.';

// ---------------------------------------------------------------- the classification cascade, as data
//
// FIVE RULES, EVALUATED IN ORDER, ALL OF THEM — not short-circuited. Short-circuiting is what produces a confident wrong
// label: a commit that rewrites configuration AND source would satisfy rule 4 and then never reach rule 5, so the tool
// would never learn that two explanations compete. Every rule that can fire is asked, and MORE THAN ONE FIRING IS
// `INCONCLUSIVE` rather than a precedence decision. A cascade that resolved ties by order would be hiding its own
// ambiguity behind a numbering.
//
// The cascade classifies an OBSERVED TRANSITION. It is not a cause analysis, it does not apportion a commit, and where it
// cannot decide it says so rather than choosing.
const CENSUS_CASCADE = [
  { order: 1, id: 'TEST_EVOLUTION' },
  { order: 2, id: 'CROSS_PACKAGE_MIGRATION' },
  { order: 3, id: 'CROSS_PACKAGE_COMPLETED' },
  { order: 4, id: 'PREDICATE_DESIGN' },
  { order: 5, id: 'SOURCE_CHANGE' },
];
const CENSUS_CASCADE_IDS = CENSUS_CASCADE.map((rule) => rule.id);

/**
 * MECHANICAL test-file shapes. A path is a test file if its basename matches one of these and it lives inside the
 * package the failing step OWNS — a `.spec.ts` in a different package is not this step's test. The list is data, not
 * code, so a language this repository does not use can be added without touching the rule.
 */
const CENSUS_TEST_FILE_PATTERNS = [
  /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.(go|py|rb)$/,
  /(^|\/)[^/]+Test\.java$/,
  /(^|\/)__tests__\//,
  /(^|\/)(tests?|spec)\//,
];

/**
 * THE CASCADE'S OWN ERROR MODES, AS DATA. Each is a shape the cascade CANNOT resolve, measured on this repository's real
 * history rather than imagined. They are fields on every classification and printed with the record, because a
 * limitation that exists only in the manual is a limitation a reader of the artifact never meets.
 */
const CENSUS_ERROR_MODES = {
  CONFOUNDED_CONFIG_AND_SOURCE:
    "one commit rewrote the step's configuration AND source files, so rules 4 and 5 both fire and this is INCONCLUSIVE rather than a label. The two explanations cannot be apportioned from a diff: this program cannot say which of the two moved the verdict, and it does not pick one.",
  MIXED_TEST_AND_SOURCE_COMMIT:
    'one commit touched test files AND source files, so rule 1 does not fire and the commit falls through to SOURCE_CHANGE — which reports a test rewrite as though it were a production change. This program CANNOT distinguish a fix that also adjusted its tests from a test edit that accompanied a real source change, and it will report SOURCE_CHANGE either way. `mixed_test_and_source_change` is true on the record so the reader is never misled by the label alone.',
  TEST_EDIT_MAY_MASK_A_REGRESSION:
    'rule 1 fired on a FAIL->PASS transition, so the ONLY thing this commit changed is what the predicate measures. A test-only change can HEAL a real regression, and this program CANNOT tell a deliberately relaxed or deleted assertion from an assertion corrected to match intended behaviour. `masks_a_regression_possible` is true on the record, and a TEST_EVOLUTION classification is explicitly NOT a claim that the production code improved. The label is still emitted rather than INCONCLUSIVE: a diff that touched nothing but the tests is not in competition with any other explanation, and saying which explanation fits is different from saying the code got better.',
  PRODUCER_PACKAGE_UNRESOLVED:
    "a commit touched a package the failing step does not own, but the commit's changed EXPORTS could not be read, so rule 2 could not be asked the question it needs answered. Absence of the signature is not evidence of absence of the migration.",
  SIGNATURE_UNAVAILABLE:
    "the failing step's output tail is not available in the record, so no rule that depends on an error signature could be asked. Rules 2 and 3 are UNDECIDABLE here, and an undecidable rule does not silently not-fire: its absence from `fired` is accompanied by this mode.",
  DIFF_UNAVAILABLE:
    "the transition commit's changed-path list could not be read from git, so every rule that reads a diff is undecidable and the classification is INCONCLUSIVE. The cascade never falls back to SOURCE_CHANGE on missing evidence, because SOURCE_CHANGE is an assertion about a diff it did not read.",
};

const CENSUS_CLASSIFICATION_BASIS =
  'a classification describes the SHAPE of the diff at an observed transition, read mechanically. It is not a cause, it does not apportion a commit, and it does not establish that the named mechanism is what moved the verdict — only that the mechanical rule fired. Where more than one rule fires, or the evidence a rule needs is unavailable, the classification is INCONCLUSIVE rather than a choice between them.';

/** Refused as a search, in the same words, every time. There is no flag, no subcommand and no stub. */
const CENSUS_NOT_A_SEARCH =
  'a census is NOT a search. It enumerates exactly the commits --from..--to names, reports every one of them, and never narrows, halves, selects a midpoint, proposes a next commit to measure, or emits a "first bad commit". git bisect remains a recorded NO-GO with no command, no flag and no stub: a break is later fixed, git has no representation for a flaky predicate, and mapping an undecidable commit onto git\'s 125 "skip" suppresses the very commit that would explain the disagreement.';

const CENSUS_TRANSITION_NOT_A_CAUSE =
  'A TRANSITION IS NOT A CAUSE. A commit under comparison is a CANDIDATE; a comparison reports an OBSERVED TRANSITION between two named commits; a candidate is never named as the responsible party, because a candidate can be the boundary and still be innocent.';

const CENSUS_LIMITATIONS = [
  `a worktree is not a security boundary, and historical reproducibility is not result authenticity. A same-principal writer controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger, and no field in a census record proves a result authentic.`,
  CENSUS_NOT_A_SEARCH,
  CENSUS_TRANSITION_NOT_A_CAUSE,
  CENSUS_CLASSIFICATION_BASIS,
  'a single observation per commit cannot distinguish a flaky predicate from a real difference. There is no per-commit repetition here: a census commit is ONE trial, and one trial is labelled as one.',
  // THE ORDER-COUPLED RESIDUAL, CARRIED ACROSS. `regress --repeat` defeats an order-coupled defect by ROTATING the first
  // position per trial, because a defect positively correlated with execution order is then inconsistent WITH ITSELF and
  // the contradiction rule can fire. A census has no such counterpart and cannot have one: it measures every commit
  // EXACTLY ONCE, in a fixed oldest-to-newest order, with no rotation, no interleaving and no second trial. So the exact
  // schedule the interleaving fix was built to defeat is the census's ONLY schedule. The consequence is recorded rather
  // than engineered away: a defect coupled to the trial-index PARITY, to the ABSOLUTE ORDER of gate executions in the
  // session, or to a one-shot resource consumed once per session stays consistent across every row and CANNOT be
  // distinguished from a real difference in the history. Any schedule is periodic, so a defect periodic with the schedule
  // is aligned with it by construction; randomising the order would manufacture apparent exchangeability rather than
  // establish it, and this program will not do that. `exchangeability: assumed, unverified`, and what breaks it, is the
  // standing assumption everywhere else in this harness.
  "ORDER-COUPLED RESIDUAL, AND IT IS WORSE HERE THAN IN A COMPARISON. Every census row is ONE trial, measured in a FIXED oldest-to-newest order, with no rotation, no interleaving and no second trial — so the schedule `regress --repeat` was built to defeat is this command's ONLY schedule. A defect coupled to the trial-index PARITY, to the ABSOLUTE ORDER of gate executions in the session, or to a one-shot resource consumed once per session is consistent across every row, cannot disagree with itself, and therefore CANNOT be distinguished from a real difference in the history. `exchangeability: assumed, unverified`, and what breaks it, is the same standing assumption as everywhere else here. The order is a DISCLOSURE, never a classification input: nothing in the derivation reads it.",
  'every commit is measured through the SAME `workspace prepare` and the SAME `evaluate --step`, so a difference between two rows is a difference between two attested workspaces. It is never a difference between two harnesses, because there is only one.',
  `the monotonicity verdict applies to ${CENSUS_MONOTONICITY_SCOPE}. A range measured from a different starting point, with a different step, under a different environment policy, or on a different machine can carry a different verdict over the same commits, and that is not a contradiction of this one.`,
];

// ---------------------------------------------------------------- census: range resolution

/**
 * Resolve the range MECHANICALLY and refuse anything that would require choosing a path on the operator's behalf.
 * `--from` must be an ancestor of `--to`: where two branches diverge there are several linear orders of the same
 * commits and picking one is a decision this program must not make silently. When that happens the range is REFUSED BY
 * NAME, with both commits printed, and the operator names a pair of refs that does have one order.
 */
function censusResolveRange({ fromRef, toRef }) {
  const from = normalizeCommitSha((git(['rev-parse', '--verify', `${fromRef}^{commit}`], REPO_ROOT) ?? '').trim());
  const to = normalizeCommitSha((git(['rev-parse', '--verify', `${toRef}^{commit}`], REPO_ROOT) ?? '').trim());

  if (from === null) {
    return {
      ok: false,
      refusal: 'not_an_ancestor_path',
      reason: `--from=${fromRef} does not resolve to a commit in this repository`,
    };
  }

  if (to === null) {
    return {
      ok: false,
      refusal: 'not_an_ancestor_path',
      reason: `--to=${toRef} does not resolve to a commit in this repository`,
    };
  }

  // `git()` returns stdout on success and `null` on ANY non-zero exit, so the ancestry question is answered by asking
  // whether the call produced output at all: `--is-ancestor` prints nothing when it succeeds.
  if (git(['merge-base', '--is-ancestor', from, to], REPO_ROOT) === null) {
    return {
      ok: false,
      refusal: 'not_an_ancestor_path',
      reason: `${from} (--from) is not an ancestor of ${to} (--to), so the range has no single linear order. This program refuses to choose a path between diverged branches: where two orders exist, picking one is a decision about which history to describe, and it is yours, not this program's. Name a --from/--to pair that is a single ancestry path.`,
    };
  }

  const listed = git(['rev-list', '--reverse', '--first-parent', '--ancestry-path', `${from}..${to}`], REPO_ROOT);
  const rest =
    listed === null || listed.trim() === ''
      ? []
      : listed
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
  const commits = [from, ...rest.filter((commit) => commit !== from)];

  return { ok: true, from, to, commits };
}

/** The bound is a COST bound, refused by name, and the only sanctioned way past it is for the operator to narrow by hand. */
const CENSUS_MAX_COMMITS = 299;
const CENSUS_MAX_COMMITS_BASIS = `a census commit costs a real historical install, a real historical build and a real gate run, so a range of ${CENSUS_MAX_COMMITS} is a bound on COST and not on interest. It is refused BEFORE any workspace exists, and the only way past it is to name a SHORTER range yourself: this program will not split the range, will not sample it, and will not measure a subset of what it was asked for and report it as the whole.`;

// ---------------------------------------------------------------- census: per-commit diff evidence

/** The changed paths of ONE commit, `--root` included so the repository's first commit is measurable. `null` = unreadable. */
function censusChangedPaths(commit) {
  const result = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit], REPO_ROOT);

  if (result === null) {
    return null;
  }

  return result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Is this path inside the package the step OWNS? `''` (the root manifest) owns everything, which is the truth. */
function censusPathInPackage(path, packagePath) {
  const dir = packagePath === 'package.json' ? '' : packagePath.replace(/\/package\.json$/, '');

  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

function censusIsTestPath(path, packagePath) {
  return censusPathInPackage(path, packagePath) && CENSUS_TEST_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

/** The step's OWN package, read out of the gate definition — never out of the contract, never guessed. */
function censusStepPackage(gateName, stepName) {
  const step = (GATES[gateName] ?? []).find((candidate) => candidate.step === stepName);

  if (step === undefined) {
    return null;
  }

  return { step, package_path: gateStepScript(step)?.packagePath ?? null, category: step.category ?? null };
}

/** The top-level directories that are DECLARED packages, from the transition commit's own tree. */
function censusDeclaredPackages(commit) {
  const top = git(['ls-tree', '--name-only', commit], REPO_ROOT);

  if (top === null) {
    return [];
  }

  return top
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name !== '' && censusChangedPathsOfTree(commit, `${name}/package.json`));
}

function censusChangedPathsOfTree(commit, path) {
  return git(['cat-file', '-e', `${commit}:${path}`], REPO_ROOT) !== null;
}

/**
 * The exported NAMES a commit adds inside one package, read off its own added lines. `null` = unreadable.
 *
 * The argv is BUILT, never concatenated: an earlier version passed the string `<sha> -- <dir>` as a SINGLE argument,
 * which git rejects as an ambiguous revision. Every call therefore returned `null`, the foreign `exports` were
 * permanently unreadable, and both cross-package rules were permanently `undecidable` — the "names a changed export of it"
 * half of rule 2 and the whole of rule 3 could never be asked. A rule that cannot be evaluated is decoration.
 */
function censusAddedExports(commit, dir) {
  const result =
    dir === null || dir === undefined || dir === ''
      ? git(['show', '--format=', '-U0', commit], REPO_ROOT)
      : git(['show', '--format=', '-U0', commit, '--', dir], REPO_ROOT);

  if (result === null) {
    return null;
  }

  const names = new Set();
  const declarations =
    /export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:const|let|var|function|async\s+function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  const lists = /export\s*(?:type\s*)?\{([^}]*)\}/g;

  for (const line of result.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    for (const match of line.matchAll(declarations)) {
      names.add(match[1]);
    }

    for (const match of line.matchAll(lists)) {
      for (const part of match[1].split(',')) {
        const name = part
          .split(/\s+as\s+/)
          .pop()
          ?.trim()
          .replace(/^type\s+/, '');

        if (name !== undefined && name !== '' && /^[A-Za-z_$][\w$]*$/.test(name)) {
          names.add(name);
        }
      }
    }
  }

  return [...names].sort();
}

/**
 * The exports of the FOREIGN packages a commit touched, read PER PACKAGE DIRECTORY. The directory is derived from the
 * changed path because a foreign path is by construction inside a declared package, and the package is the thing whose
 * exports a cross-package rule has to name. `names` is the flattened set; `unreadable` names the directories whose diff
 * could not be read, so a partial read is never presented as a complete one.
 */
function censusForeignPackageExports(commit, foreignPaths) {
  const byDirectory = new Map();

  for (const path of foreignPaths) {
    const dir = path.split('/')[0];

    if (dir === '' || byDirectory.has(dir)) {
      continue;
    }

    byDirectory.set(dir, censusAddedExports(commit, dir));
  }

  return {
    directories: Object.fromEntries([...byDirectory.entries()].map(([dir, entry]) => [dir, entry])),
    names: [...new Set([...byDirectory.values()].filter((entry) => entry !== null).flat())].sort(),
    unreadable: [...byDirectory.entries()]
      .filter(([, entry]) => entry === null)
      .map(([dir]) => dir)
      .sort(),
  };
}

/** A path under a conventional GENERATED-output directory. A pattern, deliberately narrow and documented as one. */
const CENSUS_GENERATED_DIR_RE = /(^|\/)(dist|build|out|coverage|\.next|__generated__|generated)\//;

/**
 * Is this path a GENERATED artefact rather than a source file? Two mechanical tests, and the second is deliberately
 * looser than the first: `check-ignore` asks the repository's own `.gitignore`, and the convention test catches a
 * generated directory this repository never listed. The looser test can be wrong about a tracked file that happens to
 * sit in `dist/`, which is why the classification that uses it also records the paths themselves and why its basis says
 * a generated path is a shape, not a cause.
 */
function censusIsGeneratedPath(commit, path) {
  if (git(['check-ignore', '-q', '--no-index', '--', path], REPO_ROOT) !== null) {
    return true;
  }

  return CENSUS_GENERATED_DIR_RE.test(path);
}

/**
 * Does this file, AS OF that commit, read or write a generated path? This is the only way the shape "only a generated
 * artefact moved the verdict" is visible at all: a gitignored artefact is BY DEFINITION absent from `git diff-tree`, so
 * the diff of the commit that changed the verdict contains nothing but the file that now points at it. Without this
 * probe the acceptance-corpus shape G is indistinguishable from an ordinary test edit, and the census would report a
 * predicate that is a function of build output as though it were a predicate over commits.
 *
 * It is a bounded, mechanical read: the blob at that commit, one regex, no evaluation of its contents.
 */
function censusReferencesGeneratedPath(commit, path) {
  if (git(['cat-file', '-e', `${commit}:${path}`], REPO_ROOT) === null) {
    return null;
  }

  const blob = gitShowBytes(commit, path);

  if (blob === null) {
    return null;
  }

  const text = blob.toString('utf8');
  const match = text.match(/(?:require\(|from\s+|import\s+|readFileSync\()\s*['"`]([^'"`]+)['"`]/g);

  if (match === null) {
    return null;
  }

  const referenced = match
    .map((token) => token.replace(/^[^'"`]*['"`]/, '').replace(/['"`]$/, ''))
    .filter((target) => CENSUS_GENERATED_DIR_RE.test(target));

  return referenced.length === 0 ? null : [...new Set(referenced)];
}

/** The error SIGNATURE of a step run: the identifiers named on compiler/test ERROR lines of its output tail. */
function censusErrorSignature(tail) {
  if (typeof tail !== 'string' || tail === '') {
    return null;
  }

  const names = new Set();

  for (const line of tail.split('\n')) {
    if (!/(error TS\d+|TS\d+:|FAIL\b|✗|AssertionError|Error:)/.test(line)) {
      continue;
    }

    for (const match of line.matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
      names.add(match[1]);
    }

    for (const match of line.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) {
      names.add(match[1]);
    }
  }

  return [...names].sort();
}

// ---------------------------------------------------------------- census: the cascade
//
// One pure function over the diff evidence at a transition. It writes nothing, spawns nothing, and its output is the
// classification object. Keeping it pure is what makes `INCONCLUSIVE` testable without a repository: the self-test
// drives the same function the CLI drives.
function censusClassifyTransition({
  step,
  gateName,
  commit,
  fromCommit,
  changedPaths,
  signatureBefore,
  signatureAfter,
  buildStateChanged,
  gateExecutionChanged,
  // "The step's own configuration resolution changed" — read as the RESOLVED SCRIPT VALUE differing between the two
  // measured rows, which is the one mechanical fact available about it. Deliberately NOT conditioned on the source being
  // unchanged: a commit that rewrote the configuration AND the source is the measured CONFOUNDED shape, and BOTH rules
  // must fire so the cascade reports INCONCLUSIVE instead of silently choosing the source explanation.
  scriptValueChanged = false,
  isReversal,
}) {
  const packagePath = censusStepPackage(gateName, step)?.package_path ?? 'package.json';
  const category = censusStepPackage(gateName, step)?.category ?? null;
  const declared = censusDeclaredPackages(commit);
  const evidenceUnavailable = [];

  if (changedPaths === null) {
    evidenceUnavailable.push('DIFF_UNAVAILABLE');

    return {
      classification: 'INCONCLUSIVE',
      rule: null,
      fired: [],
      not_fired: CENSUS_CASCADE_IDS,
      undecidable: CENSUS_CASCADE_IDS,
      inapplicable: [],
      basis: `the changed-path list of ${commit} could not be read from git, so no rule of the cascade could be asked. An absent diff is not evidence of an absent source change, so this is INCONCLUSIVE and not SOURCE_CHANGE.`,
      evidence_available: false,
      unavailable_reason: `git diff-tree could not be read for ${commit}`,
      multiple_rules_fired: false,
      undecidable_rules: true,
      inapplicable: [],
      confounded: false,
      mixed_test_and_source_change: false,
      masks_a_regression_possible: false,
      error_modes: ['DIFF_UNAVAILABLE'],
      changed_paths: null,
      test_changed_paths: null,
      non_test_changed_paths: null,
      foreign_package_paths: null,
      changed_exports: null,
      classification_basis: CENSUS_CLASSIFICATION_BASIS,
      error_modes_basis: CENSUS_ERROR_MODES,
    };
  }

  const testPaths = changedPaths.filter((path) => censusIsTestPath(path, packagePath));
  const nonTestPaths = changedPaths.filter((path) => !censusIsTestPath(path, packagePath));
  const foreignPaths = changedPaths.filter(
    (path) =>
      !censusPathInPackage(path, packagePath) && declared.some((dir) => path === dir || path.startsWith(`${dir}/`)),
  );
  const generatedPaths = changedPaths.filter((path) => censusIsGeneratedPath(commit, path));
  // Read per FOREIGN PACKAGE, not once for the whole commit: a rule that must name WHICH package an identifier came from
  // cannot be answered by one flattened set, and the previous single flattened read was in any case unreachable.
  const foreignExportRead = censusForeignPackageExports(commit, foreignPaths);
  const foreignExports = foreignPaths.length === 0 ? [] : foreignExportRead.names;
  const foreignExportsUnreadable = foreignPaths.length === 0 ? [] : foreignExportRead.unreadable;
  const fired = [];
  const notFired = [];
  const undecidable = [];
  const inapplicable = [];
  const subrules = {};
  // EXCLUSIVITY, and the distinction the measured evidence forced. Not every rule competes with the residual, and
  // EXCLUSIVITY IS NOT A PROPERTY OF A RULE'S NUMBER — it is a property of a rule AND of the diff in front of it:
  //
  //   EXCLUSIVE, UNCONDITIONALLY (rule 1 only). A commit that touched nothing but the step's own test files did not also
  //   change the source. Reporting INCONCLUSIVE there would be refusing to say the one thing the diff says unambiguously,
  //   and the acceptance-corpus shape E depends on it: a test-only commit must classify as TEST_EVOLUTION, with "a
  //   test-only change is not a fix of the code" attached.
  //
  //   EXCLUSIVE, CONDITIONALLY (rule 3). It suppresses the residual ONLY when the diff touched nothing but foreign
  //   packages, which cannot simultaneously be a source change in the step's own package. When the same diff also changed
  //   files inside the step's own package, rule 3 is COMPETING and `SOURCE_CHANGE` fires beside it. The schema stated
  //   exclusivity for "rules 1 and 3" as a single sentence; that was false for rule 3, which fired at essentially every
  //   `typecheck` reversal and suppressed the residual that would have marked those diffs as plain source changes.
  //
  //   COMPETING, UNCONDITIONALLY (rules 2 and 4). Each ADDS to a plain source change rather than replacing it. A commit
  //   that rewrote a producer package's exports, or that moved build state, is ALSO a source change, and which of the
  //   two explanations moved the verdict is exactly what this program cannot see. That overlap is the
  //   confounded-commit error mode, and it is why those two produce INCONCLUSIVE.
  let anExclusiveRuleFired = false;

  // 1. TEST_EVOLUTION — the transition commit's diff touches ONLY files matching the step's test glob. A `lint` or
  //    `typecheck` step owns no test glob at all, so the rule is not merely unfired there: it is INAPPLICABLE, and saying
  //    so is different from silently not applying it.
  if (category !== 'test_failure') {
    notFired.push('TEST_EVOLUTION');
    // INAPPLICABLE, not UNDECIDABLE. A `lint` step owns no test glob, so the rule is out of scope here — which is a
    // different fact from "the evidence needed to ask it was missing", and only the second one withholds a label.
    inapplicable.push('TEST_EVOLUTION');
  } else if (changedPaths.length > 0 && nonTestPaths.length === 0) {
    fired.push('TEST_EVOLUTION');
    anExclusiveRuleFired = true;
    subrules.TEST_EVOLUTION = { test_glob: CENSUS_TEST_FILE_PATTERNS.map(String), changed: testPaths };
  } else {
    notFired.push('TEST_EVOLUTION');
  }

  // 2. CROSS_PACKAGE_MIGRATION — the commit touches a PRODUCER package the failing step does not own, AND the error
  //    signature names a changed export of it. Both halves are required: the package touch alone is not a migration, and
  //    a signature alone names no producer.
  if (foreignPaths.length === 0) {
    notFired.push('CROSS_PACKAGE_MIGRATION');
  } else if (signatureAfter === null) {
    notFired.push('CROSS_PACKAGE_MIGRATION');
    undecidable.push('CROSS_PACKAGE_MIGRATION');
    evidenceUnavailable.push('SIGNATURE_UNAVAILABLE');
  } else if (foreignExportsUnreadable.length > 0) {
    notFired.push('CROSS_PACKAGE_MIGRATION');
    undecidable.push('CROSS_PACKAGE_MIGRATION');
    evidenceUnavailable.push('PRODUCER_PACKAGE_UNRESOLVED');
  } else if (signatureAfter.some((name) => foreignExports.includes(name))) {
    fired.push('CROSS_PACKAGE_MIGRATION');
    subrules.CROSS_PACKAGE_MIGRATION = {
      foreign_paths: foreignPaths,
      foreign_packages: Object.keys(foreignExportRead.directories),
      signature_matches: signatureAfter.filter((name) => foreignExports.includes(name)),
    };
  } else {
    notFired.push('CROSS_PACKAGE_MIGRATION');
  }

  // 3. CROSS_PACKAGE_COMPLETED — the commit touches a FOREIGN package, an export of THAT foreign package is named by the
  //    failing signature, and the name is GONE from the signature afterwards. A cross-package thing completed, and the
  //    completion is visible only as the disappearance of a name a foreign package owned.
  //
  //    WHAT THIS RULE WAS, AND WHY IT WAS A CONFIDENT WRONG LABEL RATHER THAN AN INCONCLUSIVE ONE. It tested
  //    `foreignPaths.length === 0` — the exact NEGATION of being cross-package — plus "a signature name disappeared". At a
  //    `FAIL->PASS` transition the after-tail is a success message with no error lines, so `gone` was non-empty whenever
  //    the failing run had printed any identifier at all. Measured: a DOCS-ONLY change, a RENAME, a COMMENT-LINE change
  //    and a one-file in-package source fix each classified as `CROSS_PACKAGE_COMPLETED`, so it fired at essentially every
  //    `typecheck` reversal, including this cycle's own "3 cross-package contract migration" attributions. It also set
  //    `anExclusiveRuleFired`, which SUPPRESSES the `SOURCE_CHANGE` residual, so the wrong label additionally swallowed
  //    the residual that would otherwise have marked the diff as a plain source change.
  //
  //    TWO HALVES, BOTH REQUIRED; the second is what makes the rule cross-package at all. A rename inside the step's own
  //    package is not a cross-package completion, and neither is a comment.
  //
  //    EVIDENCE BEFORE SCOPE, deliberately — the one ordering here that reads backwards. A missing signature makes the
  //    rule UNDECIDABLE and is disclosed even when the diff touches no foreign package at all, because calling it "out of
  //    scope" would hide the fact that the output tail was never recorded. A rule whose evidence is missing withholds a
  //    label rather than quietly passing.
  if (nonTestPaths.length === 0) {
    // A diff that touched nothing but the step's own test files contains no foreign path at all, so there is no
    // cross-package completion to describe whatever the signature says. NOT fired and NOT undecidable, because nothing is
    // MISSING here — this is the one case whose answer is known without any signature at all, so asking for one would
    // withhold a label over a rule that was never in scope. Asked first for exactly that reason.
    notFired.push('CROSS_PACKAGE_COMPLETED');
  } else if (signatureBefore === null || signatureAfter === null) {
    // EVIDENCE BEFORE SCOPE, and it is deliberate: a missing signature is disclosed even when the diff touches no
    // foreign package, because calling that "out of scope" would hide the fact that the output tail was never recorded.
    // A rule whose evidence is missing withholds a label rather than quietly passing.
    notFired.push('CROSS_PACKAGE_COMPLETED');
    undecidable.push('CROSS_PACKAGE_COMPLETED');
    evidenceUnavailable.push('SIGNATURE_UNAVAILABLE');
  } else if (foreignPaths.length === 0) {
    // The cross-package half cannot be asked of a diff that touches no foreign package. NOT fired and NOT undecidable:
    // the evidence was there, the rule simply had nothing to describe.
    notFired.push('CROSS_PACKAGE_COMPLETED');
  } else if (foreignExportsUnreadable.length > 0) {
    // A PARTIAL read is not a complete one: the export list of at least one foreign package could not be read, so "the
    // disappeared name belonged to no foreign package" cannot be concluded from it.
    notFired.push('CROSS_PACKAGE_COMPLETED');
    undecidable.push('CROSS_PACKAGE_COMPLETED');
    evidenceUnavailable.push('PRODUCER_PACKAGE_UNRESOLVED');
  } else {
    const remaining = signatureAfter;
    const gone = signatureBefore.filter((name) => !remaining.includes(name));
    const goneForeignExports = gone.filter((name) => foreignExports.includes(name));
    // EXCLUSIVITY IS CONDITIONAL AND MECHANICAL. A diff that touched nothing but foreign packages cannot also be a plain
    // source change in the step's own package, so the residual is suppressed. A diff that touched foreign packages AND
    // the step's own files can be both, so rule 3 is COMPETING there and `SOURCE_CHANGE` fires alongside it, which is
    // what makes the classification INCONCLUSIVE rather than a confident label. The old UNCONDITIONAL exclusivity was
    // false for rule 3, and only rule 1 holds it unconditionally.
    const foreignOnly = nonTestPaths.length > 0 && nonTestPaths.every((path) => foreignPaths.includes(path));

    if (goneForeignExports.length > 0) {
      fired.push('CROSS_PACKAGE_COMPLETED');

      if (foreignOnly) {
        anExclusiveRuleFired = true;
      }

      subrules.CROSS_PACKAGE_COMPLETED = {
        disappeared: gone,
        disappeared_foreign_exports: goneForeignExports,
        still_present: remaining,
        foreign_paths: foreignPaths,
        foreign_packages: Object.keys(foreignExportRead.directories),
        foreign_paths_only: foreignOnly,
        exclusivity: foreignOnly
          ? "EXCLUSIVE: the diff touched only foreign packages, so it cannot also be a source change in the step's own package and the SOURCE_CHANGE residual is suppressed"
          : "COMPETING: the diff also changed files inside the step's own package, so a plain source change is a live explanation and SOURCE_CHANGE fires beside this rule, which makes the classification INCONCLUSIVE",
      };
    } else {
      notFired.push('CROSS_PACKAGE_COMPLETED');
    }
  }

  // 4. PREDICATE_DESIGN / BUILD_STATE — the failing path is in a gitignored/generated path, or the step's own
  //    configuration resolution changed while no relevant source changed. A verdict that is a function of BUILD STATE is
  //    not a predicate over commits at all, and this is the rule that says so out loud.
  //
  //    THREE triggers, and the second is the one that matters. Asking only whether a changed path IS generated is
  //    silently useless for a gitignored artefact, because such a path is BY DEFINITION absent from `git diff-tree` — the
  //    diff of the commit that changed the verdict contains nothing but the file that now points at it. So the rule also
  //    asks whether any changed file READS a generated path, and whether the attested build state moved at all.
  //
  //    PREDICATE_DESIGN is a COMPETING rule, never an exclusive one: a commit that redirected the predicate at build
  //    output is also a source change, and which of the two moved the verdict is exactly what cannot be seen. It fires
  //    even when rule 1 also fired, so a build-state predicate is reported as INCONCLUSIVE rather than as a confident
  //    TEST_EVOLUTION that reads as "the tests changed".
  const generatedReferences = changedPaths
    .map((path) => ({ path, referenced: censusReferencesGeneratedPath(commit, path) }))
    .filter((entry) => entry.referenced !== null);
  const allGenerated = changedPaths.length > 0 && generatedPaths.length === changedPaths.length;
  const readsGenerated = generatedReferences.length > 0;

  if (
    allGenerated ||
    readsGenerated ||
    scriptValueChanged === true ||
    (gateExecutionChanged === true && buildStateChanged === true)
  ) {
    fired.push('PREDICATE_DESIGN');
    subrules.PREDICATE_DESIGN = {
      subrule:
        buildStateChanged === true ? 'BUILD_STATE' : scriptValueChanged === true ? 'CONFIGURATION' : 'GENERATED_PATH',
      // WHAT `subrule` IS, stated on the record because the name reads like a classification and is not one. It says
      // WHICH of the three triggers fired; it is never the reported classification. GENERATED_PATH in particular cannot
      // BE the classification: PREDICATE_DESIGN is a COMPETING rule that never suppresses the SOURCE_CHANGE residual, so
      // a generated-path trigger always fires beside SOURCE_CHANGE and the classification is always INCONCLUSIVE. The
      // sub-rule is fully reachable and is asserted to be — what is unreachable is the idea that it could ever be the
      // answer on its own, and that is now a field rather than a reader's assumption.
      subrule_is_a_trigger_not_a_classification: true,
      classification_always_inconclusive:
        buildStateChanged === true || scriptValueChanged === true
          ? null
          : 'the GENERATED_PATH trigger fired and PREDICATE_DESIGN is a COMPETING rule, so SOURCE_CHANGE fires beside it and this classification is always INCONCLUSIVE. `subrule` names WHICH trigger fired; it is never the reported classification.',
      generated_paths: generatedPaths,
      // Each `{path, referenced}` pair says which changed file started reading generated output. Without this the rule
      // would fire on a diff whose generated paths are all absent, and the reader could not tell why.
      files_reading_generated_paths: generatedReferences,
      build_state_changed: buildStateChanged,
      gate_execution_changed: gateExecutionChanged,
      step_configuration_changed: scriptValueChanged === true,
    };
  } else {
    notFired.push('PREDICATE_DESIGN');
  }

  // 5. SOURCE_CHANGE — the residual. It fires whenever a diff WAS read and no EXCLUSIVE rule already described it, and it
  //    fires ALONGSIDE the two COMPETING rules, because that overlap is the point: the overlap is what INCONCLUSIVE is
  //    made of. A residual suppressed by an exclusive rule would not be a residual; it would be a fifth name for the
  //    same diff.
  if (!anExclusiveRuleFired) {
    fired.push('SOURCE_CHANGE');
  }

  const multiple = fired.length > 1;
  // MISSING EVIDENCE WITHHOLDS A LABEL, exactly as competing rules do. A rule that could not be ASKED is not a rule
  // that did not fire, and collapsing the two would let an unreadable signature produce a confident SOURCE_CHANGE.
  // An INAPPLICABLE rule is different again: it was never in scope, so it withholds nothing.
  const undecidableEvidence = undecidable.length > 0;
  // CONFOUNDED means PREDICATE_DESIGN fired TOGETHER WITH another rule — a build-state or configuration explanation and a
  // second one, whatever that second one is. Which of the two moved the verdict is what this program cannot see.
  const confounded = fired.includes('PREDICATE_DESIGN') && fired.length > 1;
  const mixedTestAndSource = testPaths.length > 0 && nonTestPaths.length > 0;
  const masksRegression = fired.includes('TEST_EVOLUTION') && isReversal === true;
  const errorModes = [];

  if (confounded) {
    errorModes.push('CONFOUNDED_CONFIG_AND_SOURCE');
  }

  if (mixedTestAndSource) {
    errorModes.push('MIXED_TEST_AND_SOURCE_COMMIT');
  }

  if (masksRegression) {
    errorModes.push('TEST_EDIT_MAY_MASK_A_REGRESSION');
  }

  for (const mode of evidenceUnavailable) {
    if (Object.hasOwn(CENSUS_ERROR_MODES, mode)) {
      errorModes.push(mode);
    }
  }

  return {
    // A single firing is the classification. More than one is INCONCLUSIVE, and an unavailable diff is INCONCLUSIVE.
    // There is no precedence among the rules and no way to ask for one.
    classification: multiple || undecidableEvidence ? 'INCONCLUSIVE' : fired[0],
    rule: multiple || undecidableEvidence ? null : (fired[0] ?? null),
    fired,
    not_fired: notFired,
    undecidable,
    inapplicable,
    basis: multiple
      ? `${fired.length} rules of the 5-way cascade fired at this transition (${fired.join(', ')}), and the cascade is INCONCLUSIVE rather than choosing between them by order. ${errorModes
          .map((mode) => CENSUS_ERROR_MODES[mode])
          .join(' ')}`
      : undecidableEvidence
        ? `${undecidable.length} rule(s) of the 5-way cascade could not be ASKED at this transition (${undecidable.join(', ')}): ${evidenceUnavailable.join(', ')}. A rule that could not be asked is not a rule that did not fire, so the cascade is INCONCLUSIVE rather than reporting the residual as if nothing were missing. ${errorModes
            .map((mode) => CENSUS_ERROR_MODES[mode])
            .join(' ')}`
        : `${fired[0]} is the only rule that fired at this transition. ${masksRegression ? 'The ONLY change was to what the predicate measures: a test-only change is NOT a fix of the code, and this program cannot tell a deliberately relaxed assertion from a corrected one. ' : ''}${CENSUS_CLASSIFICATION_BASIS}`,
    evidence_available: true,
    unavailable_reason: evidenceUnavailable.length === 0 ? null : evidenceUnavailable.join(', '),
    multiple_rules_fired: multiple,
    undecidable_rules: undecidableEvidence,
    // Recorded so a reader can see WHICH rules were in competition, and therefore which INCONCLUSIVE is structural and
    // which was chosen: an exclusive rule suppresses the residual, a competing one deliberately does not.
    exclusive_rule_fired: anExclusiveRuleFired ? (fired.find((id) => id !== 'SOURCE_CHANGE') ?? null) : null,
    confounded,
    mixed_test_and_source_change: mixedTestAndSource,
    masks_a_regression_possible: masksRegression,
    error_modes: errorModes,
    changed_paths: changedPaths,
    test_changed_paths: testPaths,
    non_test_changed_paths: nonTestPaths,
    foreign_package_paths: foreignPaths,
    changed_exports: foreignExports,
    // WHICH package each of those exports came from, and which foreign packages' diffs could not be read. A reader
    // asking "which package did this identifier come from" — which is the whole of what rules 2 and 3 ask — cannot
    // answer it from a flattened name list, and a partial read is never presented as a complete one.
    changed_exports_by_package: foreignPaths.length === 0 ? null : foreignExportRead.directories,
    changed_exports_unreadable_packages: foreignPaths.length === 0 ? null : foreignExportsUnreadable,
    subrules,
    from_commit: fromCommit,
    commit,
    classification_basis: CENSUS_CLASSIFICATION_BASIS,
    error_modes_basis: CENSUS_ERROR_MODES,
  };
}

// ---------------------------------------------------------------- census: the matrix derivation
//
// Every function below is a PURE function of the per-commit rows. That is what keeps the derivation auditable: the
// regions, the transitions, the candidates and the monotonicity verdict can all be recomputed from `matrix` alone, and
// nothing here spawns a process or touches a ledger.

/**
 * A HOLE IS A HOLE IN A RUN, NOT A BOUNDARY BETWEEN RUNS. The three undecided states do not close a region: only a
 * DECIDED non-FAIL row does. The reason is that a region is a statement about an unbroken run of observed failures, and an
 * undecided commit observes nothing — it has no state to break the run with. Closing on it manufactured a SECOND region
 * out of one defect: `P F U F F` reported two independent failure regions, a `NOT_MONOTONE` verdict, and a basis
 * claiming "a range that heals is not a range with one break in it" while its own matrix printed `UNDEFINED` and nothing
 * healed at all. A false DIRTY verdict is worse than a false clean one, because it invites a reader to hunt a second
 * regression that does not exist. The hole is kept ON the region (`holes`, `interrupted_by_hole`, and a wider
 * `commit_span` than `length`) and the range is UNDETERMINED rather than NOT_MONOTONE — see `censusMonotonicity`.
 */
function censusRegions(rows) {
  const regions = [];
  let current = null;

  const close = () => {
    if (current !== null) {
      regions.push(current);
      current = null;
    }
  };

  for (const row of rows) {
    if (row.state === 'FAIL') {
      if (current === null) {
        current = {
          start_index: row.index,
          end_index: row.index,
          start_commit: row.commit,
          end_commit: row.commit,
          length: 1,
          holes: [],
        };
      } else {
        current.end_index = row.index;
        current.end_commit = row.commit;
        current.length += 1;
      }

      continue;
    }

    if (CENSUS_HOLE_STATES.includes(row.state)) {
      if (current !== null) {
        current.holes.push({ index: row.index, commit: row.commit, state: row.state, reason: row.reason ?? null });
      }

      continue;
    }

    close();
  }

  close();

  for (const region of regions) {
    region.commit_span = region.end_index - region.start_index + 1;
    region.interrupted_by_hole = region.holes.length > 0;
    region.contiguous_fail_run = region.holes.length === 0;
    region.basis =
      region.holes.length === 0
        ? `a contiguous run of ${region.length} observed FAIL commit(s), ${region.start_commit}..${region.end_commit}. Every commit inside it was decided and failed, so the run is unbroken.`
        : `a run of ${region.length} observed FAIL commit(s), ${region.start_commit}..${region.end_commit}, interrupted by ${region.holes.length} UNDECIDED commit(s) (${region.holes.map((hole) => `${hole.commit} ${hole.state}`).join(', ')}). Those commits are HOLES IN this run, not a boundary between two runs: nothing healed and no second region was observed. \`length\` counts the observed failures and \`commit_span\` counts the whole span, and the difference is exactly the unmeasured part. The range is UNDETERMINED because of them, and an UNDETERMINED range is never counted as NOT_MONOTONE on the strength of its own holes.`;
  }

  return regions;
}

/**
 * Every PASS->FAIL and FAIL->PASS boundary ADJACENT IN THE MEASURED RANGE, with the evidence available at it. An
 * adjacent pair only: a commit that is UNDEFINED or INCONCLUSIVE between two PASS commits is not a transition, and the
 * matrix reports the gap where it is rather than bridging it.
 */
function censusTransitions(rows, { task, gateName, step, extraFlags, fingerprintTier, gateEnvPolicy }) {
  const transitions = [];

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];

    if (previous.state !== 'PASS' && previous.state !== 'FAIL') {
      continue;
    }

    if (current.state !== 'PASS' && current.state !== 'FAIL') {
      continue;
    }

    if (previous.state === current.state) {
      continue;
    }

    // The commit that INTRODUCED the change at this boundary is ALWAYS the later row, in both directions. Reading the
    // reversal's boundary commit as the last FAIL was a real bug caught by the shaped fixtures: it named the commit the
    // reversal healed FROM, so the classification was computed against a diff that did not move the verdict.
    const transitionCommit = current.commit;
    const fromCommit = previous.commit;
    const isReversal = current.state === 'PASS';

    transitions.push({
      index,
      kind: isReversal ? 'FAIL->PASS' : 'PASS->FAIL',
      direction: isReversal ? 'reversal' : 'onset',
      step,
      gate: gateName,
      from_commit: fromCommit,
      to_commit: current.commit,
      transition_commit: transitionCommit,
      from_state: previous.state,
      to_state: current.state,
      is_reversal: isReversal,
      // The classification is derived ONCE, before the evidence block is assembled, because the "where the change was
      // NOT" disclosure below is a function of the diff the classification read. Deriving it twice would be two chances
      // to disagree with itself.
      evidence: (() => {
        const classification = classifyFor(transitionCommit, isReversal, previous, current);

        return {
          from_run_id: previous.run_id,
          to_run_id: current.run_id,
          from_gate_exit_code: previous.gate_exit_code,
          to_gate_exit_code: current.gate_exit_code,
          from_build_state_digest: previous.build_state_digest,
          to_build_state_digest: current.build_state_digest,
          from_installed_tree_fingerprint: previous.installed_tree_fingerprint,
          to_installed_tree_fingerprint: current.installed_tree_fingerprint,
          from_lockfile_digest: previous.lockfile_digest,
          to_lockfile_digest: current.lockfile_digest,
          from_gate_execution_digest: previous.gate_execution_digest,
          to_gate_execution_digest: current.gate_execution_digest,
          from_step_scope: previous.step_scope,
          to_step_scope: current.step_scope,
          classification,
          // Stated next to the evidence it qualifies: these are the observations the classification could NOT make, and
          // they are the reason `lockfile_digest` alone is not a substitute for `installed_tree_fingerprint`/`build_state`.
          source_change_located: false,
          outside_the_source: noteOutsideTheSource(previous, current, classification),
        };
      })(),
      // A transition is not a cause. Said here, where the boundary is named, in the same words as everywhere else.
      terminology: CENSUS_TRANSITION_NOT_A_CAUSE,
    });
  }

  return transitions;

  function classifyFor(transitionCommit, isReversal, before, after) {
    const failing = isReversal ? before : after;
    const passing = isReversal ? after : before;

    return censusClassifyTransition({
      step,
      gateName,
      commit: transitionCommit,
      fromCommit: before.commit,
      changedPaths: censusChangedPaths(transitionCommit),
      // On an ONSET both sides of the comparison are the failing run; on a REVERSAL the "before" is the run that
      // failed and the "after" is the one that healed, so the signature that DISAPPEARED is the one to look for.
      signatureBefore: failing.signature,
      signatureAfter: isReversal ? passing.signature : failing.signature,
      buildStateChanged: failing.build_state_digest !== passing.build_state_digest,
      gateExecutionChanged: failing.gate_execution_digest !== passing.gate_execution_digest,
      // The step's OWN resolved script, read out of each row's `step_scope` — Phase-1's record, not a re-derivation.
      scriptValueChanged: (failing.step_scope?.script_value ?? null) !== (passing.step_scope?.script_value ?? null),
      isReversal,
    });
  }

  /**
   * The disclosure that says WHERE the change was NOT. Deliberately CONSERVATIVE, and each note requires THREE things
   * at once: the declared dependency side is byte-identical, this program observed a different installed tree, AND the
   * transition commit's own diff declares no manifest. Without the third condition a fingerprint that differs for any
   * unrelated reason would be reported as "the change was not in the source", which is the kind of confident wrong
   * statement this whole command exists to avoid.
   */
  function noteOutsideTheSource(before, after, classification) {
    const notes = [];
    const changed = classification.changed_paths;
    const declaredSideUntouched =
      before.lockfile_digest === after.lockfile_digest &&
      before.installed_state_digest === after.installed_state_digest;
    const noManifestInDiff =
      changed === null ||
      !changed.some((path) => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|\.npmrc)$/.test(path));

    // The CONTENT tier ONLY. A metadata walk records names, sizes and timestamps, and a fresh `npm ci` into a fresh
    // worktree reproduces none of those, so at the metadata tier this fingerprint differs across essentially every pair
    // of commits for reasons that have nothing to do with the history. Reporting that as "the change was not in the
    // source" would be exactly the confident wrong statement this whole command exists to avoid, so the disclosure is
    // made only where the observation can mean something — and the refusal to make it otherwise is itself recorded.
    const contentTier =
      before.installed_tree_fingerprint_tier === 'content' && after.installed_tree_fingerprint_tier === 'content';

    if (
      declaredSideUntouched &&
      noManifestInDiff &&
      contentTier &&
      before.installed_tree_fingerprint !== after.installed_tree_fingerprint
    ) {
      notes.push(
        "the lockfile digest and npm's own installed_state_digest are byte-identical across this transition, this commit changed no manifest, and THIS program's own installed_tree_fingerprint — measured at the CONTENT tier — differs: the change was NOT in the declared dependency set, and a lockfile digest alone could not have seen it. A `file:`-protocol dependency installs as a symlink, so both declared-side records record the LINK and never the target's bytes.",
      );
    } else if (!contentTier && before.installed_tree_fingerprint !== after.installed_tree_fingerprint) {
      notes.push(
        'the installed tree fingerprint differs across this transition, but it was taken at the METADATA tier, where a fresh install into a fresh worktree reproduces no name, size or timestamp. This program therefore CANNOT say from this evidence whether the installed BYTES changed. Re-measure at --fingerprint=content to make that disclosure possible; the absence of a stronger claim here is not a claim that nothing outside the source moved.',
      );
    }

    if (before.build_state_digest !== after.build_state_digest) {
      notes.push(
        'the attested build_state digest differs across this transition. A predicate whose verdict is a function of generated build output is not a predicate over commits, and this is disclosed rather than resolved.',
      );
    }

    if (notes.length === 0) {
      notes.push(
        'nothing in the attested environment explains this transition by itself; the classification above is read from the diff, and the diff is a shape, not a cause',
      );
    }

    return notes;
  }
}

/**
 * The CANDIDATES: the commit at each region's PASS->FAIL boundary, and ONLY that. A region that opens at the first commit
 * of the range has no preceding PASS inside the range, so its candidate is an explicit `null` with a reason — never the
 * first commit measured, which would be a boundary this run did not compare.
 */
function censusCandidates(regions, rows) {
  return regions.map((region, order) => {
    // `rows` is indexed by position, and a row's own `index` is its position in the measured range, so this is the
    // commit immediately before the region BEGINS. `null` means the region opens at the first commit measured.
    const preceding = rows[region.start_index - 1] ?? null;
    const precedingState = preceding?.state ?? null;
    // A candidate is emitted ONLY where a PASS->FAIL boundary was actually OBSERVED, which means the commit before the
    // region must be a row this run measured AND recorded as PASS. The previous code special-cased only
    // `start_index === 0` and interpolated `${preceding.commit} PASS` for every other region, so a region whose
    // predecessor was UNDEFINED was reported with a basis naming that commit as PASS — the same report printing it as
    // UNDEFINED three lines above. A state that was never observed is never interpolated into a basis.
    const observedBoundary = preceding !== null && precedingState === 'PASS';
    const isOpenAtRangeEdge = region.start_index === 0;

    return {
      region: order,
      // The field is named `candidate` and nothing else names it. There is no `cause` field to read and no
      // field, and no `responsible` field, so a consumer that wants a cause has to write one itself.
      candidate: observedBoundary ? region.start_commit : null,
      // Whether a PASS->FAIL boundary was OBSERVED adjacent to this region. A field rather than an inference from
      // `candidate === null`, because the two null cases have DIFFERENT reasons and a reader is entitled to both.
      boundary_observed: observedBoundary,
      // The state actually observed immediately before the region, or an explicit null at the range edge. Never a
      // guessed state.
      preceding_observed_state: precedingState,
      preceding_commit: preceding?.commit ?? null,
      candidate_reason: isOpenAtRangeEdge
        ? 'open_at_range_edge'
        : observedBoundary
          ? 'observed_pass_to_fail_boundary'
          : 'preceding_commit_not_observed_pass',
      candidate_basis: isOpenAtRangeEdge
        ? 'this region is OPEN at the first commit of the measured range, so no PASS precedes it INSIDE the range and this run compared no boundary. The candidate is null because the answer is outside the range, not because the range was searched and nothing was found.'
        : observedBoundary
          ? `the commit at the OBSERVED PASS->FAIL boundary of region ${order + 1} (${preceding.commit} PASS, ${region.start_commit} FAIL) is a CANDIDATE. A transition is not a cause: this commit is the boundary and can still be innocent.`
          : `NO CANDIDATE for region ${order + 1}: the commit immediately before it, ${preceding.commit}, was observed ${precedingState} and NOT PASS, so no PASS->FAIL boundary was OBSERVED anywhere adjacent to this region. Whatever happened between them is inside the unmeasured gap, and a candidate would have to be named without a comparison. The candidate is null because this run observed no boundary, not because the range was searched and nothing was found.`,
      region_start: region.start_commit,
      region_end: region.end_commit,
      region_length: region.length,
      region_commit_span: region.commit_span ?? null,
      region_interrupted_by_hole: region.interrupted_by_hole === true,
      terminology: CENSUS_TRANSITION_NOT_A_CAUSE,
    };
  });
}

/**
 * THE VERDICT, decided in this order and only in this order:
 *
 *   1. any reversal observed inside the range              -> NOT_MONOTONE
 *   2. more than one disjoint failure region               -> NOT_MONOTONE
 *   3. any UNDEFINED / INCONCLUSIVE / ERROR commit         -> UNDETERMINED
 *   4. otherwise                                           -> MONOTONE
 *
 * Step 1 precedes step 3 on purpose. A hole elsewhere in the range does not un-observe a reversal that WAS observed, so a
 * range containing both a reversal and an UNDEFINED commit is NOT_MONOTONE — and the UNDEFINED commits are still
 * enumerated, still non-resolving, and still refuse any verdict about themselves. `MONOTONE` is structurally
 * unreachable while `has_reversal` is true: there is no branch that reaches it.
 */
function censusMonotonicity({ rows, regions, step, gateName, fromCommit, toCommit, commitCount }) {
  const hasReversal = rows.some((row, index) => index > 0 && rows[index - 1].state === 'FAIL' && row.state === 'PASS');
  const undecided = rows.filter((row) => row.state === 'UNDEFINED' || row.state === 'INCONCLUSIVE');
  const errored = rows.filter((row) => row.state === 'ERROR');
  const counts = Object.fromEntries(
    CENSUS_STATES.map((state) => [state, rows.filter((row) => row.state === state).length]),
  );

  // THE STRUCTURAL HOLE GUARD. `censusRegions` no longer closes a run on a hole, so two regions can only be separated by
  // a DECIDED PASS. This asks that question directly anyway, because the failure it guards against is a FALSE DIRTY
  // verdict: more than one region with NOTHING but holes between them is not "the range contains N disjoint failure
  // regions", and reporting it as such is what turned `P F U F F` into a NOT_MONOTONE that claimed something healed when
  // nothing had. It is computed, asserted and reachable-by-construction rather than assumed, because an assumption here is
  // a bug waiting for the next matrix shape.
  const separatedOnlyByHoles =
    regions.length > 1 &&
    regions.slice(1).every((region, order) => {
      const between = rows.slice(regions[order].end_index + 1, region.start_index);
      return between.length > 0 && between.every((row) => CENSUS_HOLE_STATES.includes(row.state));
    });
  const holesInsideRegions = regions.reduce((total, region) => total + (region.holes?.length ?? 0), 0);

  let verdict = 'MONOTONE';
  let basis =
    'every commit in the measured range was decided, no FAIL->PASS reversal was observed, and at most one failure region exists, running to the end of the range if there is one.';

  if (hasReversal) {
    verdict = 'NOT_MONOTONE';
    basis = `at least one FAIL->PASS reversal was OBSERVED inside the measured range${regions.length > 1 ? `, and the range contains ${regions.length} failure regions` : ''}. A reversal is a fact this program watched happen between two adjacent measured commits, so it decides the verdict on its own evidence; a hole elsewhere in the range does not un-observe it and is still enumerated beside it. A single boundary is therefore not identified and is not printed: a range that heals is not a range with one break in it, and naming one commit would be a claim the measurement does not support.`;
  } else if (regions.length > 1 && separatedOnlyByHoles) {
    // Unreachable while `censusRegions` does not close a run on a hole, and asserted as such. If it ever fires it means
    // the region derivation regressed, and the safe reading of a self-contradictory matrix is UNDETERMINED, never dirty.
    verdict = 'UNDETERMINED';
    basis = `the derivation reported ${regions.length} failure regions while NOTHING but undecided commits separates them, which is a contradiction rather than a finding: no observed PASS divides these runs, so nothing healed. The verdict is UNDETERMINED, and NOT_MONOTONE is never printed on the strength of this program's own holes.`;
  } else if (regions.length > 1) {
    verdict = 'NOT_MONOTONE';
    basis = `the range contains ${regions.length} disjoint failure regions, separated by at least one observed PASS between each pair. Nothing healed between them, so any single region is an arbitrary choice among equals. A single boundary is therefore not identified and is not printed: a range that heals is not a range with one break in it, and naming one commit would be a claim the measurement does not support.`;
  } else if (undecided.length > 0 || errored.length > 0) {
    verdict = 'UNDETERMINED';
    basis = `no reversal was observed${regions.length === 1 ? `, and the one failure region${holesInsideRegions > 0 ? ` holds ${holesInsideRegions} undecided commit(s) INSIDE it` : ''}` : ''}, but ${undecided.length} commit(s) are UNDEFINED or INCONCLUSIVE and ${errored.length} are ERROR, so the range has a hole in it and carries no verdict in either direction. The undecided commits are enumerated below and are never skipped and never counted as FAIL.`;
  }

  const carriesNoInformation = counts.PASS === rows.length;

  return {
    step,
    gate: gateName,
    scope: CENSUS_MONOTONICITY_SCOPE,
    from_commit: fromCommit,
    to_commit: toCommit,
    commits_measured: commitCount,
    verdict,
    has_reversal: hasReversal,
    failure_regions: regions.length,
    // The hole arithmetic, on the verdict itself rather than only on the regions: how many undecided commits sit INSIDE
    // a failure run, and whether any two regions are separated by holes alone. `false` here is the structural claim that
    // a hole can no longer manufacture a dirty verdict, and it is what the self-test asserts.
    holes_inside_regions: holesInsideRegions,
    regions_separated_only_by_holes: separatedOnlyByHoles,
    a_hole_never_splits_a_region: true,
    undecided_commits: undecided.map((row) => ({
      index: row.index,
      commit: row.commit,
      state: row.state,
      reason: row.reason,
    })),
    errored_commits: errored.map((row) => ({
      index: row.index,
      commit: row.commit,
      state: row.state,
      reason: row.reason,
    })),
    counts,
    carries_no_information: carriesNoInformation,
    carries_no_information_basis: carriesNoInformation ? CENSUS_NO_INFORMATION_BASIS : null,
    // Structural, and asserted as such by the self-test: MONOTONE is not reachable while a reversal is present.
    monotone_requires_no_reversal: true,
    scope_basis: CENSUS_MONOTONICITY_BASIS,
    basis,
    never_a_claim_about_the_repository:
      'this verdict is about the measured range only. It is not a claim about the repository, about any commit outside --from..--to, or about any step other than the one named.',
  };
}

/**
 * THE REFUSAL. Emitted whenever the history is non-monotone, and it says the one thing a tool that has just measured a
 * non-monotone history must not let a reader infer: a single boundary is NOT identified, and here is why. It is a
 * refusal to name one commit as the responsible party, not a hedge attached to a name that was printed anyway.
 */
function censusRefusal({ monotonicity, regions, transitions }) {
  if (monotonicity.verdict !== 'NOT_MONOTONE') {
    return null;
  }

  const reasons = [];

  if (monotonicity.has_reversal) {
    reasons.push(
      `at least one FAIL->PASS reversal was observed inside the measured range (${transitions.filter((entry) => entry.is_reversal).length} of them), so the predicate is not a step function of the commit and no single boundary exists to be named`,
    );
  }

  if (regions.length > 1) {
    reasons.push(
      `the range contains ${regions.length} INDEPENDENT failure regions (${regions.map((region) => `${region.start_commit.slice(0, 12)}..${region.end_commit.slice(0, 12)}`).join(', ')}), so any single one of them is an arbitrary choice among equals`,
    );
  }

  return {
    refused: 'single_boundary',
    single_boundary_identified: false,
    reason: reasons.join('; '),
    // The alternative this tool does NOT offer, named so a reader does not go looking for it.
    not_offered: ['first_bad_commit', 'midpoint_selection', 'narrowing', 'bisection'],
    not_a_search: CENSUS_NOT_A_SEARCH,
    terminology: CENSUS_TRANSITION_NOT_A_CAUSE,
    what_is_instead:
      'the full per-commit matrix, every failure REGION with its 40-hex endpoints and length, every OBSERVED TRANSITION, the mechanical classification of each, and the CANDIDATE commits at the PASS->FAIL boundaries. A candidate can be the boundary and still be innocent.',
  };
}

/** UNDEFINED is ENUMERATED AND NON-RESOLVING. Never skipped, never a FAIL, never a direction. */
function censusUnresolvedBlock({ rows, transitions }) {
  const undefinedRows = rows.filter((row) => row.state === 'UNDEFINED');
  const inconclusiveRows = rows.filter((row) => row.state === 'INCONCLUSIVE');

  return {
    undefined_commits: undefinedRows.map((row) => ({
      index: row.index,
      commit: row.commit,
      reason: row.step_scope?.reason ?? null,
      detail: row.step_scope?.detail ?? null,
      // A step the judged commit's own manifests do not declare spawned NOTHING. That is not red, not green and not a
      // failure: it is a commit about which this measurement has nothing to say, and it is listed rather than dropped.
      spawned: false,
      gate_exit_code: null,
    })),
    inconclusive_commits: inconclusiveRows.map((row) => ({ index: row.index, commit: row.commit, reason: row.reason })),
    // Transitions are never bridged across a gap: the adjacency rule reads the two measured neighbours and an
    // undecided commit is not a PASS and not a FAIL, so it breaks the pair rather than being stepped over.
    transitions_bridged_a_gap: false,
    non_resolving: true,
    basis:
      'an UNDEFINED or INCONCLUSIVE commit is enumerated, never skipped and never counted as a FAIL. It resolves nothing in either direction: the matrix records the gap and the verdict withholds itself rather than reading across it. Note the difference from git, whose 125 means "exclude this commit and keep searching", which is exactly the narrowing this command does not do.',
    undefined_basis: STEP_SCOPE_UNDEFINED_BASIS,
    transitions_spanning_a_gap: transitions.filter(
      (entry) =>
        entry.evidence.from_step_scope?.state === 'UNDEFINED' || entry.evidence.to_step_scope?.state === 'UNDEFINED',
    ),
  };
}

// ---------------------------------------------------------------- census: the command
function cmdCensus(flags) {
  const fromRef = typeof flags.from === 'string' ? flags.from.trim() : null;
  const toRef = typeof flags.to === 'string' ? flags.to.trim() : null;

  if (fromRef === null || fromRef === '') {
    fail('census requires --from=<ref> — the OLDEST commit of the range to enumerate');
  }

  if (toRef === null || toRef === '') {
    fail('census requires --to=<ref> — the NEWEST commit of the range to enumerate');
  }

  const taskId = typeof flags.task === 'string' ? flags.task : null;

  if (taskId === null) {
    fail(
      'census requires --task=<id> (a contract is the question every commit in the range answers; it is never guessed)',
    );
  }

  const task = findTask(taskId);
  const gateName = resolveGateName(flags, task);
  // The SAME flag, the SAME validation, the SAME refusal-by-name. `--step` is a Phase-1 capability and a census inherits
  // it rather than growing a second notion of "which step".
  const stepName = resolveStepFlag(flags, gateName);
  const keep = flags.keep === true;
  const extraFlags = {};
  const fingerprintTier = flags.fingerprint === undefined ? TREE_FINGERPRINT_DEFAULT_TIER : flags.fingerprint;
  // The RAW value is kept beside the resolved one, because the refusal below has to be able to name what the operator
  // actually typed. A resolved-only value is indistinguishable from a deliberate default.
  const gateEnvPolicyRaw = typeof flags['gate-env'] === 'string' ? flags['gate-env'] : null;
  const gateEnvPolicy =
    gateEnvPolicyRaw !== null && GATE_ENV_POLICIES.includes(gateEnvPolicyRaw)
      ? gateEnvPolicyRaw
      : GATE_ENV_DEFAULT_POLICY;

  if (stepName !== null) {
    extraFlags.step = stepName;
  }

  const refuse = (name, reason, extra = []) => {
    printWorkspaceSummary([
      'census:                 ' + name,
      `refusal:               ${name}`,
      `reason:                 ${reason}`,
      'when:                  refused BEFORE any workspace was prepared, installed, built or measured — the refusal never',
      '                        costs an installation',
      'exit:                  2 (command-local usage/refusal)',
      'note:                  NO VERDICT WAS EMITTED, NO DIRECTION WAS NAMED and no ledger was touched',
      ...extra,
      ...CENSUS_LIMITATIONS.map((line) => `limitation:             ${line}`),
    ]);

    return CENSUS_EXIT_USAGE;
  };

  // BOTH FLAGS ARE REFUSED BY NAME, AT THE BOUNDARY, BEFORE ANY WORKSPACE EXISTS. `--fingerprint` and `--gate-env` are the
  // two flags a census inherits from `workspace prepare`, and both used to be validated somewhere else entirely:
  //
  //   --fingerprint=<not-a-tier>  survived the whole flag parse and failed closed DEEP INSIDE workspace preparation with
  //     a generic `installed_tree_fingerprint_unavailable` refusal. The refusal text named no unrecognised TIER, so a
  //     reader saw a measurement failure and had no way to learn it was a typo. The tier is part of the reuse key, so an
  //     unrecognised one genuinely cannot be verified under any rule — but "cannot be verified" is a different statement
  //     from "you typed something that is not a tier", and only the first was being said.
  //
  //   --gate-env=<garbage>  fell back to `sanitised` in SILENCE. That is the safe direction, so the measurement was
  //     never weakened, and it was still a defect: a record that cannot distinguish a deliberate policy from a
  //     misspelled one is a record whose environment policy is not auditable. It is refused by name for the same reason
  //     `--step` and `--census-session` already are.
  // The census was the first command to refuse both of these at the boundary; it now prints the payloads `regress`,
  // `workspace prepare` and `evaluate` also print, so a reader comparing the commands cannot find a wording that says
  // one of them thinks the refusal means something different.
  if (fingerprintTier !== null && !TREE_FINGERPRINT_TIERS.includes(fingerprintTier)) {
    const refusal = unknownFingerprintTierRefusal(fingerprintTier);

    return refuse(refusal.name, refusal.reason, refusal.lines);
  }

  // The census was the first command to refuse an unrecognised `--gate-env`, and it kept its own copy of the sentence.
  // It now prints the ONE reason `evaluate`, `regress` and `workspace prepare` also print, so a reader comparing the
  // two commands cannot find a wording that says one of them thinks the refusal means something different.
  if (gateEnvPolicyRaw !== null && !GATE_ENV_POLICIES.includes(gateEnvPolicyRaw)) {
    const refusal = unknownGateEnvPolicyRefusal(gateEnvPolicyRaw);

    return refuse(refusal.name, refusal.reason, refusal.lines);
  }

  if (stepName === null) {
    // A census over the whole gate is a census over a CONJUNCTION, and the measured reason the conjunction is a bad unit
    // is on record: 60.1% of this repository's own history declares no `ui` typecheck script at all, so nine of ten
    // step-level predicates are declared at 143/143 commits while the conjunction they are folded into is not. Naming
    // the step is what makes the history measurable; refusing here is cheaper than a range of UNDEFINED rows.
    refuse(
      'step_required',
      'census requires --step=<name>. A census over a whole gate measures a CONJUNCTION, and a conjunction carries no localisation information: a gate that fails at its first step leaves every later step unmeasured, and a commit that simply never declared one of them is indistinguishable from a commit that broke it. The 60.1% "gate undefined over its own history" figure is a property of the conjunction and is contributed by exactly one member of it.',
      [`the step:            ${(GATES[gateName] ?? []).map((candidate) => candidate.step).join(', ')}`],
    );

    return CENSUS_EXIT_USAGE;
  }

  const range = censusResolveRange({ fromRef, toRef });

  if (range.ok === false) {
    return refuse(range.refusal, range.reason);
  }

  if (range.commits.length > CENSUS_MAX_COMMITS) {
    return refuse(
      'range_too_long',
      `the range ${fromRef}..${toRef} contains ${range.commits.length} commits and the enforced bound is ${CENSUS_MAX_COMMITS}. ${CENSUS_MAX_COMMITS_BASIS}`,
    );
  }

  let outPath = null;

  if (typeof flags.out === 'string') {
    try {
      outPath = resolveExternalOutputPath(flags.out);
    } catch (error) {
      return refuse('out_path_refused', String(error?.message ?? error));
    }
  }

  // The session token names ONE range of ONE step. Replaying a log against a different range is refused BY NAME, on the
  // same principle as the pair binding: a token that names a different question must not be answered with the
  // measurements of another one.
  const invocationId = regressInvocationId();
  const sessionId = resolveRepeatSession(flags['census-session']) ?? invocationId;
  const trialsLogPath = regressTrialsLogPath(sessionId);
  const trialsLogHeadPath = regressTrialsLogHeadPath(sessionId);
  const rangeBinding = censusRangeBinding({
    taskId,
    gateName,
    step: stepName,
    fromRef,
    toRef,
    fromCommit: range.from,
    toCommit: range.to,
    gateEnvPolicy,
    fingerprintTier,
  });

  const before = regressReadTrialLogVerified(trialsLogPath, { headPath: trialsLogHeadPath });

  // The reader's verdict about the log lives under `chain`; `entries` is the TRUSTED prefix. An unreadable or rewritten
  // log is refused here rather than half-believed below, and a row it cannot verify is never repaired in place.
  if (before.chain.verified !== true) {
    return refuse(
      'census_session_chain_broken',
      `the census log for session ${sessionId} is not an intact chain (${before.chain.break_reason ?? before.chain.head_reason ?? 'unverified'}; ${before.chain.entries} rows on disk, ${before.chain.verified_entries} verified). A census will not be derived from a log this program cannot verify.`,
      [
        `entries on disk:   ${before.chain.entries}`,
        `entries verified: ${before.chain.verified_entries}`,
        `chain break:     ${before.chain.break_reason ?? 'none'}`,
        `head:            ${before.chain.head_reason ?? 'agrees'}`,
      ],
    );
  }

  if (before.entries.length > 0 && !censusRangeBindingsAgree(before.entries, rangeBinding)) {
    return refuse(
      'census_session_rebound',
      `the census log for session ${sessionId} already holds ${before.entries.length} measured commit(s) of a DIFFERENT range, step, task or environment policy. Resuming it against this invocation would print an artifact whose own range names commits its rows say nothing about.`,
    );
  }

  const replayed = new Map();
  const rows = [];

  for (const [index, commit] of range.commits.entries()) {
    const existing = before.entries.find(
      (entry) => entry.kind === 'census' && entry.index === index && entry.commit === commit,
    );

    if (existing !== undefined) {
      // A REPLAYED row is a completed measurement, kept byte-for-byte and re-derived from, never re-run and never
      // rewritten. This is what makes an interrupted run resumable without losing or duplicating anything.
      replayed.set(index, true);
      rows.push(censusRowFromLogEntry(existing));
      continue;
    }

    const side = regressRunSide({
      role: 'census',
      ref: commit,
      task,
      gateName,
      extraFlags,
      fingerprintTier,
      invocationId,
      gateEnvPolicy,
      stepName,
      instanceLabel: `${CENSUS_INSTANCE_PREFIX}${invocationId}-${String(index).padStart(4, '0')}`.slice(0, 40),
    });

    const row = censusRowFromSide({ side, index, commit, stepName });

    try {
      appendRegressTrialEntry(
        trialsLogPath,
        censusLogEntry({ sessionId, rangeBinding, index, commit, stepName, gateName, taskId, row }),
        { headPath: trialsLogHeadPath },
      );
    } catch (error) {
      if (error?.code === 'TRIAL_LOG_BYTE_BOUND_EXCEEDED') {
        return refuse('census_trial_log_byte_bound', String(error?.message ?? error), [
          'the measurement so far is ON DISK and is not lost: the rows already appended are intact and the same --census-session token resumes from them, re-running nothing and rewriting nothing.',
        ]);
      }

      throw error;
    }

    rows.push(row);

    // Bounded in TIME and DISK: a range of N commits reclaims each workspace the moment its commit is measured, exactly
    // as `regress` reclaims its sides. Without --keep, only the last commit's workspace survives the loop, so a 143-commit
    // range costs one worktree rather than 143.
    if (!keep) {
      regressReclaimInstances([side]);
    }
  }

  const regions = censusRegions(rows);
  const transitions = censusTransitions(rows, {
    task,
    gateName,
    step: stepName,
    extraFlags,
    fingerprintTier,
    gateEnvPolicy,
  });
  const candidates = censusCandidates(regions, rows);
  const monotonicity = censusMonotonicity({
    rows,
    regions,
    step: stepName,
    gateName,
    fromCommit: range.from,
    toCommit: range.to,
    commitCount: rows.length,
  });
  const refusal = censusRefusal({ monotonicity, regions, transitions });
  const unresolved = censusUnresolvedBlock({ rows, transitions });
  const chainAfter = regressReadTrialLogVerified(trialsLogPath, { headPath: trialsLogHeadPath });

  if (
    chainAfter.chain.verified !== true ||
    chainAfter.chain.duplicate_trial_indices.length > 0 ||
    chainAfter.chain.duplicate_census_indices.length > 0
  ) {
    // The detector is keyed on the field a CENSUS row writes — `index@commit` — and not on `trial_index`, which a census
    // row never wrote. Before that, two concurrent `--census` runs on one `--census-session` produced indices
    // 0,0,1,1,2,2,..., both exited 1, both published a full artifact, and neither disclosed the collision, so each row
    // silently used one of two conflicting measurements of the same commit. The refusal text and the mechanism are now
    // the same claim.
    const collided = chainAfter.chain.duplicate_census_indices;
    const collision = chainAfter.chain.break_reason
      ? null
      : `a duplicate census row: ${collided.map((entry) => `index ${entry.index} (${String(entry.commit ?? 'unknown commit').slice(0, 12)}) at lines ${entry.first_line + 1} and ${entry.second_line + 1}`).join('; ')}`;

    return refuse(
      'census_session_chain_broken',
      `the census log changed under this run (${chainAfter.chain.break_reason ?? 'duplicate census index'}): two concurrent --census runs on one --census-session token wrote into one log, and the collision is detected on the key a census row actually writes (\`${chainAfter.chain.census_index_key}\`). The collision is detected and refused; it is never resolved by keeping the first row per index.${collision === null ? '' : ` (${collision})`}`,
      [
        `entries on disk:   ${chainAfter.chain.entries}`,
        `entries verified: ${chainAfter.chain.verified_entries}`,
        `duplicate census rows: ${collided.length}`,
        'what this costs:  the collided token must be ABANDONED — start a fresh --census-session. It is never reusable, because the duplicate rows stay in the log as the evidence of the collision and there is no repair path and none is offered. No artifact was published by either run.',
      ],
    );
  }

  const errored = rows.filter((row) => row.state === 'ERROR');
  const exitCode =
    errored.length > 0
      ? CENSUS_EXIT_COMMIT_ERROR
      : monotonicity.verdict === 'UNDETERMINED'
        ? CENSUS_EXIT_UNDETERMINED
        : regions.length > 0
          ? CENSUS_EXIT_FINDING
          : CENSUS_EXIT_NO_FINDING;

  const artifact = {
    schema_version: 1,
    kind: 'census',
    invocation_id: invocationId,
    created_at: new Date().toISOString(),
    task_id: taskId,
    gate: gateName,
    step: stepName,
    // The range the artifact is about, so the matrix, the regions and the verdict can never be read against a range
    // nobody chose.
    range: {
      from_ref: fromRef,
      to_ref: toRef,
      from_commit: range.from,
      to_commit: range.to,
      commits: rows.length,
      enumeration:
        'git rev-list --reverse --first-parent --ancestry-path from..to, with `from` prepended; no narrowing, no sampling, no bisection',
    },
    range_binding: rangeBinding,
    session_id: sessionId,
    resumed: replayed.size > 0,
    replayed_commits: [...replayed.keys()],
    matrix: rows,
    failure_regions: regions,
    observed_transitions: transitions,
    reversals: transitions.filter((entry) => entry.is_reversal),
    candidates,
    monotonicity,
    refusal,
    unresolved,
    cascade: {
      rules: CENSUS_CASCADE,
      classifications: transitions.map((entry) => ({
        kind: entry.kind,
        commit: entry.transition_commit,
        ...entry.evidence.classification,
      })),
    },
    error_modes: CENSUS_ERROR_MODES,
    replay_fidelity: {
      ...CENSUS_REPLAY_FIDELITY,
      rows_replayed: replayed.size,
      rows_measured_now: rows.length - replayed.size,
      // The load-bearing cell, COMPUTED rather than asserted: a derivation input that some REPLAYED row failed to carry
      // back. It must be empty, and a reader can check it without trusting this program's account of itself.
      degraded_derivation_inputs: CENSUS_REPLAY_FIDELITY.persisted_derivation_inputs.filter((field) =>
        // ABSENT, not merely null. A field a replayed row carries as `null` is a field the measurement recorded as
        // `null` — a `build_state_digest` of null means the step needed no build, and the fresh row says the same. What
        // would degrade a classification is a field the replay could not produce AT ALL, so that is what is listed.
        rows.some((row) => row.replayed === true && !Object.hasOwn(row, censusRowFieldFor(field))),
      ),
    },
    exit_code: exitCode,
    exit_rule: CENSUS_EXIT_RULE,
    exit_basis: CENSUS_EXIT_BASIS[String(exitCode)],
    limitations: CENSUS_LIMITATIONS,
    terminology: CENSUS_TRANSITION_NOT_A_CAUSE,
    is_a_search: false,
    census_trials_log: {
      path: trialsLogPath,
      entries_on_disk: chainAfter.chain.entries,
      entries_verified: chainAfter.chain.verified_entries,
      chain: chainAfter.chain,
      write_version: REPEAT_TRIALS_LOG_WRITE_VERSION,
      byte_bound: REPEAT_TRIALS_LOG_MAX_BYTES,
    },
    not_causal:
      'a census attaches no ledger, appends no evaluations[]/environments[]/verification[] entry and sets no status. It is a printed and recorded observation about a range, never a task verdict.',
    // At the TOP level, not only inside `refusal`: a monotone range has `refusal: null`, and the one sentence a reader
    // needs most is exactly the one that a `null` would have taken with it. `scope` is the same idea for the verdict.
    not_a_search: CENSUS_NOT_A_SEARCH,
    scope: CENSUS_MONOTONICITY_SCOPE,
  };

  const artifactPath = writeRegressArtifact(outPath, artifact, invocationId);

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } else {
    printCensusReport({ artifact, artifactPath, exitCode, keep, task, gateName, stepName });
  }

  return exitCode;
}

/**
 * The MATRIX field a durable-log field name appears under on a rebuilt row. `census_state` is the log's own name for
 * the census-level state and is read back as `state`, so a replay-fidelity check that looked for the key literally would
 * report a degradation that does not exist.
 */
function censusRowFieldFor(logField) {
  return logField === 'census_state' ? 'state' : logField;
}

/** The digest that makes a session token name ONE range of ONE step. The same idea as the pair binding, over a range. */
function censusRangeBinding({
  taskId,
  gateName,
  step,
  fromRef,
  toRef,
  fromCommit,
  toCommit,
  gateEnvPolicy,
  fingerprintTier,
}) {
  const subject = {
    schema_version: 1,
    kind: 'census_range',
    task_id: taskId ?? null,
    gate: gateName ?? null,
    step: step ?? null,
    requested: { from: fromRef ?? null, to: toRef ?? null },
    resolved: { from: fromCommit ?? null, to: toCommit ?? null },
    gate_env_policy: gateEnvPolicy ?? null,
    installed_tree_fingerprint_tier: fingerprintTier ?? null,
  };

  return { ...subject, binding_digest: createHash('sha256').update(canonicalJson(subject)).digest('hex').slice(0, 32) };
}

function censusRangeBindingsAgree(entries, current) {
  const recorded = entries[0]?.range_binding ?? null;

  if (recorded === null || typeof recorded !== 'object') {
    return false;
  }

  return recorded.binding_digest === current.binding_digest;
}

/** One durable row per measured commit, in the EXISTING trial-log format and chain. One writer, one reader, one chain. */
function censusLogEntry({ sessionId, rangeBinding, index, commit, stepName, gateName, taskId, row }) {
  return {
    kind: 'census',
    session_id: sessionId,
    range_binding: rangeBinding,
    index,
    commit,
    step: stepName,
    gate: gateName,
    task_id: taskId,
    state: row.state,
    reason: row.reason,
    run_id: row.run_id,
    observed_judged_commit: row.observed_judged_commit,
    observed_judged_commit_post: row.observed_judged_commit_post,
    gate_exit_code: row.gate_exit_code,
    step_scope: row.step_scope,
    workspace_key: row.workspace_key,
    workspace_instance: row.workspace_instance,
    lockfile_digest: row.lockfile_digest,
    installed_state_digest: row.installed_state_digest,
    installed_tree_fingerprint: row.installed_tree_fingerprint,
    // THE TIER IS PART OF THE FINGERPRINT, not decoration beside it. It was read back by the reader and never written by
    // the writer, so a replayed row carried `installed_tree_fingerprint_tier: null` while a measured row carried
    // `content` — and the reader's own disclosure then said "it was taken at the METADATA tier ... Re-measure at
    // --fingerprint=content" on a range whose own binding says `content`. A replay that reports a different measurement of
    // the same commits is not a replay of those commits.
    installed_tree_fingerprint_tier: row.installed_tree_fingerprint_tier ?? null,
    build_state_digest: row.build_state_digest,
    gate_execution_digest: row.gate_execution_digest,
    // THE ERROR SIGNATURE, and the reason this row is a durable record rather than a print-time derivation. The
    // classifier asks "which identifiers appeared in the failing output, and which are gone now", so a row that does not
    // carry its signature cannot be classified: a resumed census read `entry.signature ?? null`, produced
    // `SIGNATURE_UNAVAILABLE`, and reported INCONCLUSIVE where the fresh run had reported SOURCE_CHANGE. The census's
    // HEADLINE output is WHY a transition happened, and it was not reproducible from its own durable record. Persisting
    // it is what makes "re-derived from, never rewritten" true: re-derived FROM THE SAME EVIDENCE, not from less of it.
    signature: row.signature ?? null,
    // The census-level fact, stored with the measurement: a row's `UNDEFINED` is a property of that commit's own
    // manifests, and re-deriving it at print time from a workspace that no longer exists would be deciding against a
    // path that no longer resolves.
    census_state: row.state,
  };
}

/** Rebuild a matrix row from a durable log row, with the same null-normalisation as a fresh one. */
function censusRowFromLogEntry(entry) {
  return {
    index: entry.index ?? null,
    commit: entry.commit ?? null,
    requested_ref: entry.commit ?? null,
    state: entry.census_state ?? entry.state ?? null,
    reason: entry.reason ?? null,
    run_id: entry.run_id ?? null,
    observed_judged_commit: entry.observed_judged_commit ?? null,
    observed_judged_commit_post: entry.observed_judged_commit_post ?? null,
    gate_exit_code: entry.gate_exit_code ?? null,
    step_scope: entry.step_scope ?? null,
    workspace_key: entry.workspace_key ?? null,
    workspace_instance: entry.workspace_instance ?? null,
    lockfile_digest: entry.lockfile_digest ?? null,
    installed_state_digest: entry.installed_state_digest ?? null,
    installed_tree_fingerprint: entry.installed_tree_fingerprint ?? null,
    installed_tree_fingerprint_tier: entry.installed_tree_fingerprint_tier ?? null,
    build_state_digest: entry.build_state_digest ?? null,
    gate_execution_digest: entry.gate_execution_digest ?? null,
    signature: entry.signature ?? null,
    replayed: true,
    // WHAT A REPLAY DID NOT CARRY BACK, named per row rather than left as an absent key. Every field the DERIVATION
    // reads is persisted and therefore equal to a measured row; the two whole-attestation fields are not, and a
    // degradation a reader cannot see is not a disclosure.
    fields_not_persisted: censusReplayFieldsNotPersisted(entry),
  };
}

/** The whole-attestation fields a census row deliberately does not write to the trial log. */
const CENSUS_ROW_FIELDS_NOT_PERSISTED = ['environment_record', 'workspace_state'];

/**
 * The census row fields a REPLAY did not carry back, computed per row rather than asserted in prose. Both entries are
 * unbounded attestation blobs — an environment record names every digest of an installed tree and a workspace-state
 * record embeds it — and neither is read by `censusRegions`, `censusTransitions`, `censusClassifyTransition`,
 * `censusCandidates` or `censusMonotonicity`, so neither can move a verdict. A log written before the signature and the
 * tier were persisted reads them as unavailable, which is the honest reading of a record that never stored them.
 */
function censusReplayFieldsNotPersisted(entry) {
  return CENSUS_ROW_FIELDS_NOT_PERSISTED.filter((field) => entry[field] === undefined || entry[field] === null);
}

/**
 * THE REPLAY-FIDELITY RECORD, printed on every artifact. The claim is precise: every field the derivation reads is
 * persisted, so a replayed row and a measured row agree; the two whole-attestation fields are not persisted and are
 * named. A resumed census therefore reports the SAME account of a transition as a fresh one over the same commits and
 * the same session token — the same classification, not merely the same state.
 */
const CENSUS_REPLAY_FIDELITY = {
  persisted_derivation_inputs: [
    'state',
    'census_state',
    'reason',
    'signature',
    'step_scope',
    'lockfile_digest',
    'installed_state_digest',
    'installed_tree_fingerprint',
    'installed_tree_fingerprint_tier',
    'build_state_digest',
    'gate_execution_digest',
    'observed_judged_commit',
    'observed_judged_commit_post',
    'gate_exit_code',
  ],
  not_persisted: CENSUS_ROW_FIELDS_NOT_PERSISTED,
  basis:
    'a replayed row is rebuilt from the durable log and is never re-measured, so it is exactly as good as what that log stores. Every field the matrix derivation READS is persisted, which is what makes a resumed census report the same account of a transition as a fresh one over the same commits and the same session token. The two fields named above are whole attestation blobs, are not persisted, and are listed here rather than degrading silently; neither is read by any derivation, so neither can move a verdict. A log written before the signature and the tier were persisted reads them as unavailable, and that IS the honest reading of a record that never stored them.',
};

/**
 * The matrix row. EVERY field is explicit `null` on write — the additive-null rule the ledger already follows — so a
 * reader never has to distinguish "absent" from "not applicable", and a historical artifact stays readable by a reader
 * that has never heard of a census.
 */
function censusRowFromSide({ side, index, commit, stepName }) {
  // The FIVE states. `UNDEFINED` is recovered from the Phase-1 `step_scope` rather than re-derived: `classifyRegressSide`
  // reports it as INCONCLUSIVE for good reason (a pair cannot compare a step that did not run), and the census's unit is a
  // commit rather than a pair, so the distinct name is REFUNDED here. Nothing is re-classified; the same classifier
  // decided it and the census only reads the field back.
  const state = side.step_scope?.state === 'UNDEFINED' ? 'UNDEFINED' : side.state;

  return {
    index,
    commit,
    requested_ref: commit,
    state,
    reason: side.reason ?? null,
    run_id: side.run_id ?? null,
    observed_judged_commit: side.observed_judged_commit ?? null,
    observed_judged_commit_post: side.observed_judged_commit_post ?? null,
    gate_exit_code: side.gate_exit_code ?? null,
    step_scope: side.step_scope ?? null,
    workspace_key: side.workspace_key ?? null,
    workspace_instance: side.instance ?? null,
    workspace_state: side.workspace_state ?? null,
    lockfile_digest: side.lockfile_digest ?? null,
    installed_state_digest: side.workspace_installed_state_digest ?? null,
    installed_tree_fingerprint: side.workspace_installed_tree_fingerprint ?? null,
    installed_tree_fingerprint_tier: side.workspace_installed_tree_fingerprint_tier ?? null,
    build_mode: side.workspace_build_mode ?? null,
    build_outcome: side.workspace_build_outcome ?? null,
    build_state_digest: side.workspace_build_state_digest ?? null,
    gate_execution_digest: side.gate_execution?.digest ?? null,
    status_hash_pre: side.status_hash_pre ?? null,
    status_hash_post: side.status_hash_post ?? null,
    environment_record: side.environment_record ?? null,
    harness_error: side.harness_error ?? null,
    workspace_refused: side.workspace_refused ?? null,
    step_requested: stepName,
    // The error SIGNATURE, read out of the run stream's own output tail. It is read HERE, while the workspace still
    // exists, for the same reason every other environment-derived field is: the report is printed after cleanup.
    signature: censusSignatureFromRunStream(side.run_id),
    replayed: false,
  };
}

function censusSignatureFromRunStream(runId) {
  if (runId === null || runId === undefined) {
    return null;
  }

  for (const event of readRunStreamEvents(runId)) {
    if (event.event === 'verification_finished' && typeof event.output_tail === 'string') {
      return censusErrorSignature(event.output_tail);
    }
  }

  return null;
}

// ---------------------------------------------------------------- census: the report
function printCensusReport({ artifact, artifactPath, exitCode, keep, task, gateName, stepName }) {
  const {
    monotonicity,
    matrix,
    failure_regions: regions,
    observed_transitions: transitions,
    candidates,
    refusal,
    unresolved,
  } = artifact;
  const lines = [
    '',
    `census:                 ${artifact.range.commits} commits measured, step \`${stepName}\` of gate \`${gateName}\``,
    `range:                  ${artifact.range.from_commit} .. ${artifact.range.to_commit}`,
    `enumeration:            ${artifact.range.enumeration}`,
    `artifact:               ${relative(artifactPath)}`,
    '',
    '=== per-commit matrix (one step, the measured range) ===',
    ...matrix.map(
      (row) =>
        `  #${String(row.index).padStart(3, ' ')}  ${row.state.padEnd(12, ' ')}  ${row.commit}${row.replayed ? '  (replayed from the census log, not re-run)' : ''}`,
    ),
    '',
    `=== failure regions (${regions.length}) ===`,
    ...(regions.length === 0
      ? ['  none: no commit in the measured range FAILED this step']
      : regions.flatMap((region, order) => [
          `  region ${order + 1}:  ${region.start_commit} .. ${region.end_commit}  (${region.length} commit(s))`,
          `    end commits:     ${region.start_commit} -> ${region.end_commit}`,
        ])),
    '',
    `=== observed transitions (${transitions.length}) ===`,
    ...(transitions.length === 0
      ? ['  none: no two ADJACENT commits in the measured range changed verdict']
      : transitions.flatMap((entry) => [
          `  #${entry.index}  ${entry.kind}  ${entry.from_commit} -> ${entry.to_commit}`,
          `    transition commit: ${entry.transition_commit}`,
          `    classification:    ${entry.evidence.classification.classification}${entry.evidence.classification.multiple_rules_fired ? ` (INCONCLUSIVE: ${entry.evidence.classification.fired.join(' + ')} both fired)` : ''}`,
          `    diff:              ${entry.evidence.classification.changed_paths === null ? 'unreadable' : entry.evidence.classification.changed_paths.length === 0 ? '(none)' : entry.evidence.classification.changed_paths.join(', ')}`,
          ...entry.evidence.classification.error_modes.map(
            (mode) => `    error mode:        ${mode} — ${CENSUS_ERROR_MODES[mode]}`,
          ),
          `    outside the source: ${entry.evidence.outside_the_source.join(' ')}`,
          ...(entry.is_reversal
            ? [
                `    reversal:          ${entry.evidence.classification.masks_a_regression_possible ? 'the ONLY change was to the tests. A test-only change is NOT a fix of the code, and it MAY be masking a real regression.' : 'the predicate healed without the diff saying why'}`,
              ]
            : []),
        ])),
    '',
    `=== candidates (${candidates.length}) — a CANDIDATE is never the responsible party ===`,
    ...(candidates.length === 0
      ? ['  none: no failure region has a PASS->FAIL boundary inside the measured range']
      : candidates.flatMap((entry) => [
          // The summary line names WHICH of the reasons applies. Both null cases are real and they are DIFFERENT, and
          // printing the edge reason for a hole-preceded region is the same class of defect F2 is: telling the reader a
          // fact about the run that this run did not observe.
          `  region ${entry.region + 1}:  ${
            entry.candidate ??
            (entry.candidate_reason === 'open_at_range_edge'
              ? '(none — region is open at the range edge)'
              : `(none — no PASS->FAIL boundary was OBSERVED; the commit before it was ${entry.preceding_observed_state})`)
          }`,
          `    basis:             ${entry.candidate_basis}`,
        ])),
    '',
    '=== monotonicity verdict ===',
    `  step:                 ${monotonicity.step}`,
    `  scope:                ${monotonicity.scope} — ${monotonicity.from_commit} .. ${monotonicity.to_commit}, ${monotonicity.commits_measured} commit(s)`,
    `  verdict:              ${monotonicity.verdict}`,
    `  basis:                ${monotonicity.basis}`,
    `  carries no information: ${monotonicity.carries_no_information ? 'YES' : 'no'}${monotonicity.carries_no_information ? ` — ${monotonicity.carries_no_information_basis}` : ''}`,
    `  scope basis:          ${monotonicity.scope_basis}`,
    `  never a claim about:  ${monotonicity.never_a_claim_about_the_repository}`,
    '',
    `=== UNDEFINED / INCONCLUSIVE (${unresolved.undefined_commits.length} UNDEFINED, ${unresolved.inconclusive_commits.length} INCONCLUSIVE) ===`,
    ...(unresolved.undefined_commits.length === 0 && unresolved.inconclusive_commits.length === 0
      ? ['  none: every commit in the measured range was decided']
      : [
          ...unresolved.undefined_commits.map(
            (row) => `  UNDEFINED   #${row.index}  ${row.commit}  ${row.reason ?? ''} ${row.detail ?? ''}`,
          ),
          ...unresolved.inconclusive_commits.map(
            (row) => `  INCONCLUSIVE #${row.index}  ${row.commit}  ${row.reason ?? ''}`,
          ),
        ]),
    `  non-resolving:        ${unresolved.non_resolving} — ${unresolved.basis}`,
    ...(unresolved.transitions_spanning_a_gap.length > 0
      ? [
          `  spanning a gap:      ${unresolved.transitions_spanning_a_gap.length} — a transition is never read ACROSS an undecided commit`,
        ]
      : []),
    '',
    '=== refusal ===',
    ...(refusal === null
      ? [
          // Never say "monotone" here unless the verdict above actually said it. A refusal block that is absent because
          // the range is UNDETERMINED must not read as though the range were clean.
          monotonicity.verdict === 'MONOTONE'
            ? '  none needed: the measured range is MONOTONE over that same range, so the boundaries that were observed are reported and none is invented.'
            : `  none needed for a single boundary, because the verdict is ${monotonicity.verdict} and the range therefore names no single boundary at all: ${monotonicity.basis}`,
        ]
      : [
          `  refused:             ${refusal.refused}`,
          `  single boundary identified: ${refusal.single_boundary_identified}`,
          `  reason:              ${refusal.reason}`,
          `  not offered:         ${refusal.not_offered.join(', ')}`,
          `  what is instead:     ${refusal.what_is_instead}`,
        ]),
    `  a transition is not a cause: ${artifact.terminology}`,
    `  this is not a search: ${CENSUS_NOT_A_SEARCH}`,
    '',
    '=== what this tool cannot distinguish ===',
    ...Object.entries(CENSUS_ERROR_MODES).map(([id, text]) => `  ${id}: ${text}`),
    '',
    `=== provenance (one row per commit, this run's own measurements) ===`,
    `  census log:           ${artifact.census_trials_log.entries_verified}/${artifact.census_trials_log.entries_on_disk} rows verified, byte bound ${artifact.census_trials_log.byte_bound}`,
    `  resumed:              ${artifact.resumed ? `yes, ${artifact.replayed_commits.length} commit(s) REPLAYED (never re-run, never rewritten)` : 'no'}`,
    `  workspaces:           ${keep ? 'kept (--keep)' : 'each reclaimed as its commit was measured, so a long range costs one worktree at a time'}`,
    `  per-commit evidence:  run_id, observed judged_commit before AND after the gate, step_scope, environment record, build_state digest, installed_state digest AND this program's installed_tree_fingerprint with its tier, lockfile digest, gate-execution digest`,
    '',
    `census exit:           ${exitCode}`,
    `exit rule:             ${artifact.exit_rule.rule}`,
    ...CENSUS_LIMITATIONS.map((line) => `limitation:             ${line}`),
    '',
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeRegressArtifact(resolvedOutPath, artifact, invocationId = null) {
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  // Same reason as the run id: `stamp()` is millisecond-resolution, so two comparisons in the same millisecond would
  // collide on the artifact name and the loser would exit 2 — the usage code — for an operational collision.
  const path =
    resolvedOutPath === null
      ? resolveControlPath(RESULTS_DIR, `regress-${invocationId === null ? 'anonymous' : invocationId}-${stamp()}.json`)
      : resolvedOutPath;

  writeNewFileExclusive(path, bytes);

  return path;
}

/** Cleanup has an OBSERVABLE signal: a refused removal is non-zero, exactly as `workspace prune` already is. */
function regressReclaimInstances(sides) {
  const reclaimed = { performed: true, reclaimed_bytes: 0, failures: [], removed: [] };

  for (const side of sides) {
    if (side.workspace_directory === null) {
      continue;
    }

    // A2: same re-derivation as `workspace remove`/`prune`. The side knows its own key and instance, so the cleanup
    // path derives the directory rather than trusting the one the attestation recorded.
    const cleanupRoot = resolveWorkspaceRoot()?.path ?? null;
    const result = reclaimWorkspaceInstance({
      directory: side.workspace_directory,
      root: cleanupRoot,
      expectedDirectory:
        cleanupRoot === null || side.workspace_key === null
          ? null
          : workspaceInstanceDirectory(cleanupRoot, side.workspace_key, side.instance),
      force: false,
    });

    if (result.removed || result.reason === 'absent') {
      reclaimed.reclaimed_bytes += result.bytes;
      reclaimed.removed.push({ directory: side.workspace_directory, bytes: result.bytes, reason: result.reason });

      if (side.workspace_key !== null) {
        // R5: guarded. An unguarded `unlinkSync` on a path another invocation had already reclaimed threw ENOENT
        // out of the comparison, printed no report at all, and exited 2 — the USAGE code — for an operational
        // collision. An absent attestation is not an error; it is already gone.
        try {
          unlinkSync(workspaceAttestationPath(side.workspace_key, side.instance));
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            reclaimed.failures.push({
              directory: side.workspace_directory,
              reason: `attestation_unlink_failed:${String(error?.message ?? error)}`,
            });
          }
        }
      }
    } else {
      reclaimed.failures.push({ directory: side.workspace_directory, reason: result.reason });
    }
  }

  git(['worktree', 'prune']);

  return reclaimed;
}

function printRegressReport({
  good,
  target,
  comparison,
  environment,
  confirmation,
  cleanup,
  task,
  gateName,
  artifactPath,
  keep,
  exitCode,
  exitResolution,
  repeat = null,
}) {
  const materiallyDifferent = environment.differs.filter((entry) => entry.matters);
  const gateExecution = environment.gate_execution;
  // P1: the repeated-evaluation block is printed ONLY at N > 1, so an ordinary comparison's terminal output is
  // byte-for-byte what it was before `--repeat` existed. The anchor is the output, not a claim about it.
  const repeated = repeat !== null && repeat.requested > 1 ? repeat : null;
  const lines = [
    '',
    'harness regress — a comparison of two NAMED commits. Not a verdict machine, not a search, and not a bisect.',
    '',
    '=== side: good ===',
    ...regressSideLines(good),
    '',
    '=== side: target ===',
    ...regressSideLines(target),
    repeated === null
      ? null
      : [
          '',
          '=== repeated evaluation: --repeat=N ===',
          `  trials per side:     ${repeated.requested} (each trial is a complete workspace prepare + evaluate with its own instance, its own run id and its own provenance)`,
          // ORDER-AWARE, printed where a reader of the terminal output cannot miss it. The old design ran every good
          // trial and then every target trial, so an order-coupled defect was CONSISTENT BETWEEN the sides and this rule
          // never fired; the schedule below rotates the first position, so such a defect has to disagree with ITSELF.
          `  trial order:         ${repeated.executionOrder.scheme} — the first position inside a trial block ALTERNATES between the sides. This is NOT ${REGRESS_ORDER_LEGACY}`,
          `  schedule:            ${repeated.executionOrder.schedule.map((order, index) => `#${index} ${order.join(' -> ')}`).join('   |   ')}`,
          `  positions:           good = [${repeated.executionOrder.position_by_trial.good.join(', ')}]   target = [${repeated.executionOrder.position_by_trial.target.join(', ')}]   (0 = ran first in its block)`,
          `  is_legacy_order:     ${repeated.executionOrder.is_legacy_order}   scheme digest: ${repeated.executionOrder.schedule_digest}`,
          `  what that does:      ${repeated.executionOrder.basis}`,
          `  position-conditional: a DISCLOSURE, never a classification input — good: ${repeated.positionConditional.good.positions.map((entry) => `pos${entry.position} [${entry.states.join(', ') || 'no trial'}]`).join('  ')}  |  target: ${repeated.positionConditional.target.positions.map((entry) => `pos${entry.position} [${entry.states.join(', ') || 'no trial'}]`).join('  ')}`,
          `  limitation:          ${repeated.executionOrder.residual}`,
          ...(repeated.stepScope === null || repeated.stepScope === undefined
            ? []
            : [
                '',
                `  per-step mode:       every trial above ran ONE named step (${repeated.stepScope}) of gate "${gateName}", independently, with no fail-fast`,
                `  per-step good:       ${regressStepScopeBrief(good.step_scope)}`,
                `  per-step target:     ${regressStepScopeBrief(target.step_scope)}`,
                `  UNDEFINED rule:      ${STEP_SCOPE_UNDEFINED_BASIS}`,
              ]),
          `  classification rule: ${REPEAT_CLASSIFICATION_RULE}`,
          `  vote:                never used. ${REPEAT_VOTE_FORBIDDEN}`,
          ...regressRepeatLines(repeated.aggregates.good, 'good '),
          ...regressRepeatLines(repeated.aggregates.target, 'target'),
          '',
          '  resolving:           the aggregate is NEVER used to resolve a boundary. INCONCLUSIVE here is NON-RESOLVING and is NOT git\'s 125 "skip": in git, skip means "untestable - exclude this commit and keep searching", which drops the very commit that would explain the disagreement and biases the answer LATE in a fixed direction rather than at random. Here the same situation is named differently (INCONCLUSIVE, undecidable_by_contradiction), it never skips, never narrows a search, and never names the other side the winner.',
          '  git_skip_125_equivalent: false   skippable: false   resolves_boundary: false',
          `  trial log:           ${repeated.trialProvenance.filter((entry) => entry.source === 'measured_by_this_invocation').length} trial(s) measured and appended, ${repeated.trialProvenance.filter((entry) => entry.source === 'replayed_from_trial_log').length} replayed from session ${repeated.sessionId} (append-only: an interrupted run loses no completed trial, and a re-run rewrites none of them)`,
          // B1 + B2 + B3: the three checks, printed where a reader of the terminal output cannot miss them.
          `  session binding:     ${repeated.sessionBindingDigest ?? 'n/a'} — a --repeat-session token names ONE comparison (pair, task, gate, gate environment policy); a replay against a different one is refused by name (${REPLAY_REFUSAL_SESSION_BINDING})`,
          `  trial verification:  ${repeated.unverifiedCount} unverified trial(s) of ${repeated.trialsTotal}; an unverified trial makes its side INCONCLUSIVE (${REPEAT_RULE_TRIAL_UNVERIFIED}) and is never averaged away`,
          ...repeated.unverifiedLines,
          `  trial log chain:     ${repeated.chain.verified ? 'VERIFIED' : 'BROKEN'} — ${repeated.chain.verified_entries}/${repeated.chain.entries} entr(ies) trusted, head ${String(repeated.chain.head_digest ?? 'none').slice(0, 16) || 'none'}${repeated.chain.head_reason === null ? '' : `; ${repeated.chain.head_reason}`}`,
          `  what that is:        ${REPEAT_TRIALS_CHAIN_LIMIT}`,
          ...REPLAY_REFUSALS.map((limitation) => `  limitation:          ${limitation}`),
          ...REPEAT_LIMITATIONS.filter((limitation) => limitation !== REPEAT_ANTI_CONSERVATIVE_BASIS).map(
            (limitation) => `  limitation:          ${limitation}`,
          ),
          `  limitation:          the ANTI-CONSERVATIVE warning is printed only where it applies: good=${repeated.aggregates.good.bound.anti_conservative} target=${repeated.aggregates.target.bound.anti_conservative}. It fires when observing a disagreement made the bound TIGHTER than the zero-flip bound for the same N, which is an ARITHMETIC property of k >= 1 rather than a better answer and rather than a measured defect: an exact Clopper-Pearson limit at k=1 is already ~0.05/n, so an ordinary exchangeable p = 0.01 disagreement fires it too. The MEASURED evidence of a non-exchangeable defect is the 58/59-then-9/9 trap named in the warning, which is a separate observation and keeps firing on its own evidence.`,
        ],
    '',
    '=== comparison ===',
    `contract (DECLARED):    ${task.source_commit}  — a diff base, never a statement about what was executed`,
    `invocation:            ${good.invocation_id ?? '(not recorded)'} (unique per invocation, so two concurrent comparisons of the same pair can never share a workspace instance, a run id or an artifact name)`,
    `contract_digest:        ${good.contract_digest ?? 'not observed'} / ${target.contract_digest ?? 'not observed'}`,
    `gate_definition_sha256: ${GATE_DEFINITION_SHA} (a process-level constant: it can never differ between two sides, so no comparison is built on it)`,
    `commits (OBSERVED):     ${good.observed_judged_commit ?? 'not observed'} -> ${target.observed_judged_commit ?? 'not observed'}`,
    `side states:            good=${good.state} target=${target.state}`,
    // R1: the basis is printed WITH the verdict, not stored away in the artifact where a reader looking at the
    // terminal will never find it. The `verdict:` field itself stays the bare token so it remains machine-parseable,
    // and the qualification is the line immediately beneath it.
    `verdict:                ${comparison.verdict}`,
    `basis:                  ${comparison.verdict_basis} — ${comparison.verdict_basis_text}`,
    `reason:                 ${comparison.reason}`,
    comparison.confirmation_withdrawal === 'withdrawn'
      ? `withdrawn:              the direction "${comparison.withdrawal.from_verdict}" was WITHDRAWN to cannot_compare (asserted instead: none). A confirmation may refuse a direction, never assert one.`
      : null,
    // R4: THE printed number is THE process exit. It used to be the comparison's own code, computed before cleanup,
    // so a report could say `exit: 5` while the shell saw 6.
    `exit:                   ${exitCode} (command-local; never an evaluate exit code, and 3 is never emitted) — this is the value the PROCESS will return`,
    `comparison exit:        ${comparison.exit_code} (the comparison's own code, before the exit-precedence rule)`,
    `exit precedence:        ${REGRESS_EXIT_PRECEDENCE}`,
    exitResolution.cleanup_refused
      ? `exit note:             at least one removal was REFUSED; ${exitResolution.raised_by_cleanup ? `the exit was RAISED from 0 to ${exitCode}` : `the exit was NOT changed by the refusal (it remains the comparison's own code)`}`
      : null,
    '',
    '=== gate execution: what each side ACTUALLY ran (R2 disclosure) ===',
    `  gate_execution_digest: ${gateExecution.good?.digest ?? 'not recorded'} / ${gateExecution.target?.digest ?? 'not recorded'}`,
    `  gate definition:      ${GATE_DEFINITION_SHA} (process constant) + ${(gateExecution.good?.resolved_steps ?? []).length} resolved step(s)`,
    `  scripts invoked:      good:   ${regressGateScriptLines(good)}`,
    `  scripts invoked:      target: ${regressGateScriptLines(target)}`,
    gateExecution.prominent
      ? `  *** PROMINENT DISCLOSURE: ${gateExecution.disclosure.detail}`
      : '  the two sides ran the SAME gate (identical resolved definition and identical invoked script definitions)',
    gateExecution.prominent ? `      ${gateExecution.disclosure.verdict_qualifier}` : null,
    `  limit:                ${REGRESS_GATE_EXECUTION_LIMIT}`,
    '',
    // B5. The scope is stated, so a trial-0 table can never again read as a statement about the whole comparison.
    `environment comparison: ${environment.trial_0_only ? `TRIAL 0 ONLY of ${repeated === null ? 2 : repeated.environmentAcrossTrials.trials_compared} trial(s) — the remaining trials are compared in environment_comparison_across_trials` : 'all trials'}`,
    ...(repeated === null
      ? []
      : [
          ...repeated.environmentAcrossTrials.varying_fields.map(
            (field) =>
              `  VARIES ACROSS TRIALS:  ${field} — a trial-0 table cannot show this, and it is an unrecorded variable until it is named`,
          ),
          repeated.environmentAcrossTrials.contradiction
            ? `  CONTRADICTION:         ${repeated.environmentAcrossTrials.contradiction_fields.join('; ')} varies WITHIN a side, so the sides did not answer the same question and BOTH are INCONCLUSIVE (${REPEAT_RULE_PAIR_INPUT})`
            : null,
        ]),
    'environment comparison (a difference here is a DISCLOSURE, never a verdict):',
    ...environment.rows.map(
      (row) =>
        `  ${row.field.padEnd(26)} ${String(row.good ?? 'not recorded').padEnd(18)} ${String(row.target ?? 'not recorded').padEnd(18)} ${row.differs ? (row.matters ? 'DIFFERS (material)' : 'differs (informational)') : 'same'}`,
    ),
    materiallyDifferent.length === 0
      ? '  no material environment difference was observed between the two sides'
      : `  material differences: ${materiallyDifferent.map((entry) => `${entry.field} (${entry.good ?? 'not recorded'} -> ${entry.target ?? 'not recorded'})`).join('; ')}`,
    ...environment.disclosures.map((entry) => `  DISCLOSURE (${entry.kind}, non-authoritative): ${entry.detail}`),
  ];

  if (confirmation !== null) {
    lines.push(
      '',
      'second observation (--confirm-disagreement, NON-AUTHORITATIVE — it never asserts a direction of its own):',
      `  side/step:            ${confirmation.performed ? `${confirmation.side} :: ${confirmation.step} (${confirmation.command})` : 'not performed'}`,
      ...(confirmation.observations ?? []).map(
        (observation) =>
          `  ${observation.observation.padEnd(42)} exit ${observation.exit_code ?? 'null'}${observation.duration_ms === null ? '' : ` (${observation.duration_ms} ms)`}`,
      ),
      confirmation.performed === true
        ? `  environment policy:   ${confirmation.environment_policy} (the SAME policy the comparison ran under${confirmation.environment_policy_matches_comparison ? '' : ' — MISMATCH, recorded'})`
        : null,
      confirmation.performed === true
        ? `  contradicts first?:   ${confirmation.contradicts_first_observation === null ? 'not determinable' : String(confirmation.contradicts_first_observation)}`
        : null,
      comparison.confirmation_withdrawal === 'withdrawn'
        ? `  WITHDRAWN:            the comparison observation was contradicted, so the direction was REFUSED (withdrawn to cannot_compare) rather than replaced`
        : null,
      `  limitation:           ${confirmation.limitation ?? confirmation.reason}`,
    );
  }

  lines.push(
    '',
    'cleanup:',
    `  performed:            ${cleanup.performed}`,
    `  reclaimed:            ${formatBytes(cleanup.reclaimed_bytes)} (${cleanup.removed.length} instance(s))`,
    ...cleanup.failures.map((failure) => `  FAILED:                ${failure.directory} — ${failure.reason}`),
    cleanup.performed === false ? `  note:                  ${cleanup.note}` : null,
    cleanup.failures.length > 0
      ? `  result:               at least one removal was REFUSED — never a quiet success, and ${exitResolution.raised_by_cleanup ? `the exit was raised to ${exitCode}` : `the exit was left at ${exitCode} because ${REGRESS_EXIT_PRECEDENCE}`}`
      : null,
    '',
    `artifact:               ${relative(artifactPath)}`,
    `non-causal:             ${artifactPath.endsWith('.json') ? 'regress attaches no ledger and changes no terminal state; the artifact is additive and read by no decision path. Its two evaluate runs DO appear in report — see the limitation below' : ''}`,
    ...REGRESS_LIMITATIONS.map((limitation) => `limitation:             ${limitation}`),
    '',
  );

  process.stdout.write(`${lines.filter((line) => line !== null).join('\n')}\n`);
}

/**
 * Descriptive facts about the evaluated workspace for the run stream. This is NOT the working-tree observation:
 * the authoritative pre/post `status_hash_*` pair and the judged commit come from `observeJudgedTree`, which is
 * the single implementation that records them. A digest computed here was never emitted, so it is not computed
 * here — one input, one role, one name.
 */
function captureRepoState(sourceCommit, cwd = REPO_ROOT) {
  const head = (git(['rev-parse', 'HEAD'], cwd) ?? '').trim();
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? '').trim();
  const status = git(['status', '--porcelain'], cwd) ?? '';
  // `--format=%H`, NOT `--oneline`. `--oneline` emits `<sha> <subject>`, and a commit SUBJECT is repository CONTENT
  // of unbounded length: it would make this field's byte size a function of whatever text happens to be in a commit
  // message, in a field whose whole purpose is a fixed-width comparison. `%H` is the bare 40-character sha, so every
  // element is the same width, the list is bounded by the number of commits, and nothing an author wrote can reach the
  // machine surface through it. The human summary still prints the subject — a reader wants to know WHICH commit
  // moved — but that is a text surface, and the two are not the same consumer.
  const since = git(['log', '--format=%H', `${sourceCommit}..HEAD`], cwd) ?? '';

  return {
    head,
    branch,
    dirty: status.trim() !== '',
    commitsSinceSource: since.split('\n').filter((l) => l.trim() !== ''),
  };
}

function captureWorkspaceChange(sourceCommit, cwd = REPO_ROOT) {
  const nameStatus = git(['diff', '--name-status', sourceCommit], cwd) ?? '';
  const lines = nameStatus.split('\n').filter((l) => l.trim() !== '');
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], cwd) ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .filter((l) => !isNoisePath(l))
    .map((l) => `??\t${l}`);

  const files = [...lines, ...untracked];

  return {
    files: files.slice(0, WORKSPACE_FILE_CAP),
    truncated: files.length > WORKSPACE_FILE_CAP,
    diffstat: (git(['diff', '--shortstat', sourceCommit], cwd) ?? '').trim(),
  };
}

function collectRuntimeMetrics(flags) {
  const mapping = {
    model: 'model',
    turns: 'turns',
    'tool-calls': 'tool_calls',
    'input-tokens': 'input_tokens',
    'output-tokens': 'output_tokens',
    'cached-tokens': 'cached_tokens',
    cost: 'cost',
  };

  const metrics = {};

  for (const [flag, key] of Object.entries(mapping)) {
    if (flags[flag] === undefined) {
      continue;
    }

    const raw = flags[flag];

    metrics[key] = key === 'model' ? String(raw) : Number(raw);
  }

  if (Object.keys(metrics).length > 0) {
    metrics.source = 'manual (supplied on the command line; not observed by this script)';
  }

  return metrics;
}

/**
 * The evaluated workspace, not the repository root. `cwd` was hard-coded to `REPO_ROOT` while the gate ran in
 * `workspacePath`, so every event of a `--workspace` run named the wrong directory.
 */
function environmentFacts(cwd = REPO_ROOT) {
  return {
    node: process.version,
    npm: (run('npm', ['-v'], { silent: true }).stdout ?? '').trim(),
    platform: `${process.platform}/${process.arch}`,
    cwd: recordedCwd(cwd),
  };
}

function commitExists(ref, cwd = REPO_ROOT) {
  return spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd }).status === 0;
}

function git(args, cwd = REPO_ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  return result.status === 0 ? result.stdout : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    silent: options.silent === true,
  };
}

/**
 * C11: the gate is spawned with the environment the harness CONSTRUCTS and records, not with the operator's shell
 * inherited wholesale. `NODE_PATH`/`NODE_OPTIONS` are removed (they can silently supply modules the workspace does
 * not have) and every `npm_config_*`/proxy variable is dropped; what remains is digested into the record.
 */
function runStep(step, gateLogWriter, index, cwd = REPO_ROOT, env = undefined) {
  const startedMs = Date.now();
  const result = spawnSync(step.command, step.args, { cwd, encoding: 'utf8', ...(env === undefined ? {} : { env }) });
  const durationMs = Date.now() - startedMs;
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  gateLogWriter.emitBlock(index + 1, step.step, formatCommand(step), combined);

  return {
    exitCode: result.status ?? 1,
    durationMs,
    outputTail: tailLines(combined, OUTPUT_TAIL_LINES, OUTPUT_TAIL_MAX_CHARS),
  };
}

function tailLines(text, maxLines, maxChars) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))
    .filter((l) => l.trim() !== '');

  return lines.slice(-maxLines).join('\n').slice(-maxChars);
}

function formatCommand(step) {
  return `${step.command} ${step.args.join(' ')}`;
}

// ---------------------------------------------------------------- path + writer contracts

function assertNoSymlinkComponents(path) {
  const absolute = resolve(path);
  const components = absolute.split('/').filter((component) => component !== '');
  let current = '/';

  for (const component of components) {
    current = join(current, component);

    if (!existsSync(current)) {
      continue;
    }

    if (lstatSync(current).isSymbolicLink()) {
      fail(`path component is a symlink: ${current}`);
    }
  }
}

function prepareControlRoot(root) {
  const absolute = resolve(root);
  assertNoSymlinkComponents(absolute);
  mkdirSync(root, { recursive: true });
  assertNoSymlinkComponents(absolute);

  if (realpathSync(absolute) !== absolute) {
    fail(`control root is not canonical: ${absolute}`);
  }

  return absolute;
}

function resolveControlPath(root, filename) {
  const canonicalRoot = prepareControlRoot(root);
  const candidate = resolve(canonicalRoot, filename);
  const rel = pathRelative(canonicalRoot, candidate);

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    fail(`path escapes control root ${canonicalRoot}: ${filename}`);
  }

  if (dirname(candidate) !== canonicalRoot) {
    fail(`control-plane path must be directly beneath ${canonicalRoot}: ${filename}`);
  }

  return candidate;
}

/**
 * B7. THE RESERVED STATE DIRECTORIES. `--out` is a request to write an artifact, and the harness owns these directories
 * for a specific purpose each: a run stream directory that `readRunRecords` enumerates as evidence, a ledger directory,
 * the control plane, the task contracts. Writing an artifact into one is not a formatting question.
 *
 * The pre-fix refusal covered `state/control` alone, so `--out=<harness>/state/runs/anything.jsonl` was accepted and
 * HONOURED — and a comparison artifact landed in the directory `readRunRecords` reads as run evidence, where `report`
 * then failed outright on it (`Cannot convert undefined or null to object`) and still exited 0. The safest and the
 * honest reading of an operator who names a reserved directory is that they did not mean it: refuse BY NAME.
 */
function reservedOutputDirs() {
  return [
    { path: CONTROL_DIR, what: 'the control plane (gate, lock, exclusion and worktree bookkeeping)' },
    { path: RUNS_DIR, what: 'the run-stream directory, which readRunRecords reads as evaluation evidence' },
    { path: TASKS_DIR, what: 'the task-contract directory, which loadTasks parses as contracts' },
    { path: join(STATE_DIR, 'ledgers'), what: 'the ledger directory, which holds append-only ledger records' },
    {
      path: REPEAT_TRIALS_DIR,
      what: 'the regress trial-log directory, which is a digest chain and is never rewritten',
    },
  ];
}

function resolveExternalOutputPath(raw) {
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) {
    fail('external report/telemetry --out must be an absolute path');
  }

  const candidate = resolve(raw);

  for (const reserved of reservedOutputDirs()) {
    const relativeToReserved = pathRelative(reserved.path, candidate);

    if (
      relativeToReserved === '' ||
      (!relativeToReserved.startsWith(`..${sep}`) && relativeToReserved !== '..' && !isAbsolute(relativeToReserved))
    ) {
      fail(
        `external report/telemetry --out must not target ${reserved.path} (${reserved.what}). It is refused BY NAME rather than honoured, and it is never silently redirected to the default reports path: name a path outside the harness state directory, or omit --out to take the default.`,
      );
    }
  }

  if (candidate !== raw) {
    fail(`external report/telemetry --out must be canonical: ${raw}`);
  }

  assertNoSymlinkComponents(dirname(candidate));

  let parent;

  try {
    parent = lstatSync(dirname(candidate));
  } catch {
    fail(`external report/telemetry parent does not exist: ${dirname(candidate)}`);
  }

  if (!parent.isDirectory() || realpathSync(dirname(candidate)) !== dirname(candidate)) {
    fail(`external report/telemetry parent is not a canonical directory: ${dirname(candidate)}`);
  }

  try {
    lstatSync(candidate);
    fail(`external report/telemetry target already exists: ${candidate}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return candidate;
}

function stableIoError(code, error) {
  const wrapped = new Error(`${code}: ${error?.message ?? error}`);
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}

function writeAll(fd, bytes, io) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let offset = 0;

  while (offset < buffer.length) {
    const written = io.writeSync(fd, buffer, offset, buffer.length - offset, null);

    if (written <= 0) {
      throw new Error('write made no progress');
    }

    offset += written;
  }
}

function closeDescriptor(fd, io) {
  if (fd === null) {
    return;
  }

  io.closeSync(fd);
}

function createDescriptorWriter(path, io, serialize, code, render = (value) => value) {
  let fd;
  let state = 'open';

  try {
    fd = io.openSync(path, 'wx');
  } catch (error) {
    throw stableIoError(code, error);
  }

  const failAndClose = (error) => {
    state = 'failed';

    try {
      closeDescriptor(fd, io);
    } catch {
      // Preserve the first write/close failure.
    }

    throw stableIoError(code, error);
  };

  return {
    get state() {
      return state;
    },
    emit(value) {
      if (state === 'failed') {
        throw stableIoError('WRITER_FAILED', new Error('writer already failed'));
      }

      if (state !== 'open') {
        throw stableIoError('WRITER_CLOSED', new Error('writer is closed'));
      }

      try {
        const bytes = render(serialize(value));
        writeAll(fd, bytes, io);
      } catch (error) {
        failAndClose(error);
      }
    },
    close() {
      if (state === 'closed') {
        return;
      }

      if (state === 'failed') {
        throw stableIoError('WRITER_FAILED', new Error('writer already failed'));
      }

      try {
        closeDescriptor(fd, io);
        state = 'closed';
      } catch (error) {
        state = 'failed';
        throw stableIoError(code, error);
      }
    },
  };
}

function createWriter(eventsPath, io = DEFAULT_FS) {
  let seq = 0;
  const descriptor = createDescriptorWriter(
    eventsPath,
    io,
    ({ event, payload }) => {
      seq += 1;
      return `${JSON.stringify({ seq, event, ts: new Date().toISOString(), ...payload })}\n`;
    },
    'RUN_WRITER_FAILED',
  );

  return {
    get state() {
      return descriptor.state;
    },
    emit(event, payload) {
      descriptor.emit({ event, payload });
    },
    close() {
      descriptor.close();
    },
  };
}

function gateBlockHeader(index, step, command) {
  return `=== gate-step ${index} :: ${step} :: ${command} ===\n`;
}

function gateBlockFooter(index, step, command) {
  return `=== end gate-step ${index} :: ${step} :: ${command} ===\n`;
}

function createGateLogWriter(logPath, io = DEFAULT_FS) {
  const descriptor = createDescriptorWriter(
    logPath,
    io,
    ({ index, step, command, bytes }) =>
      `${gateBlockHeader(index, step, command)}${bytes}${gateBlockFooter(index, step, command)}`,
    'GATE_LOG_WRITER_FAILED',
  );

  return {
    get state() {
      return descriptor.state;
    },
    emitBlock(index, step, command, bytes) {
      descriptor.emit({ index, step, command, bytes });
    },
    close() {
      descriptor.close();
    },
  };
}

function classifyGateLog(content, expectedSteps) {
  if (content === '') {
    return { valid: false, reason: 'empty' };
  }

  let cursor = 0;

  for (const [index, step] of expectedSteps.entries()) {
    const header = gateBlockHeader(index + 1, step.step, step.command);
    const footer = gateBlockFooter(index + 1, step.step, step.command);

    if (!content.startsWith(header, cursor)) {
      return { valid: false, reason: `order_or_command_mismatch:${index + 1}` };
    }

    const footerAt = content.indexOf(footer, cursor + header.length);

    if (footerAt === -1) {
      return { valid: false, reason: `partial_block:${index + 1}` };
    }

    cursor = footerAt + footer.length;
  }

  if (cursor !== content.length) {
    return { valid: false, reason: expectedSteps.length === 0 ? 'unexpected_block' : 'count_mismatch' };
  }

  return { valid: true, reason: null };
}

function writeNewFileExclusive(path, bytes, io = DEFAULT_FS) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let fd = null;
  let opened = false;

  try {
    fd = io.openSync(path, 'wx');
    opened = true;
    writeAll(fd, buffer, io);
    io.fsyncSync(fd);
    closeDescriptor(fd, io);
    fd = null;
  } catch (error) {
    if (fd !== null) {
      try {
        closeDescriptor(fd, io);
      } catch {
        // Preserve the publication error.
      }
    }

    if (opened) {
      try {
        io.unlinkSync(path);
      } catch {
        // A crash can strand the new-file target.
      }
    }

    throw stableIoError('NEW_FILE_WRITE_FAILED', error);
  }

  return path;
}

function generatedRunId(label) {
  return `${label.slice(0, 80)}-${stamp()}`.slice(0, 120);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function relative(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}

/**
 * The recorded form of an evaluated directory. The repository root keeps its absolute identity (so a default run records
 * exactly what it recorded before); a workspace inside the repository records its repository-relative path; a workspace
 * outside it records the absolute path. An unresolvable path is `null`, never an empty string.
 */
function recordedCwd(path) {
  if (typeof path !== 'string' || path === '') {
    return null;
  }

  return path === REPO_ROOT ? REPO_ROOT : relative(path);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function formatRate(rate) {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'HARNESS_USAGE_ERROR';
  throw error;
}

// An entry guard instead of an unconditional `main()` call, so the self-tests can import this module for the
// state-classification helpers without executing the CLI. Mirrors the guard in `self-test.mjs`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`error: ${error?.message ?? error}\n`);
    // D6: the evaluate protocol is unchanged — `fail()` carries no `exitCode`, so every usage error still exits 2.
    // Only `harness workspace` publishes a command-local set, and it does so by ATTACHING a code to its own refusal
    // error rather than by changing what any other command returns.
    process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 2);
  }
}

export {
  ancestorNodeModulesRefusal,
  appendEnvironment,
  assertNpmCacheRefusal,
  gateOutputFence,
  LEDGER_SELECTION_DISCLOSURE,
  LEDGER_WRITE_CONFLICT,
  newestEnvironmentRecord,
  NPM_CONFIG_FILES_BASIS,
  observeNpmConfigFiles,
  REGRESS_STATUS_HASH_LIMIT,
  REGRESS_STATUS_HASH_SCOPE,
  assertHistoricalProject,
  assertNoSymlinkedNodeModules,
  assertWorkspaceRootRefusals,
  buildEnvironmentEntry,
  classifyProvisioning,
  classifyGateLog,
  applyRegressConfirmation,
  classifyRegressSide,
  classifyReportPopulation,
  compareRegressEnvironments,
  compareRegressGateExecution,
  compareRegressSides,
  isComparisonSourcedRun,
  observeRegressGateExecution,
  readGateScriptDefinitions,
  regressInstanceLabel,
  regressInvocationId,
  resolveRegressExitCode,
  // ORDER-AWARE SCHEDULING. Exported so the I26 self-test group can assert the schedule is a PURE function of N, that
  // N = 1 reduces to the pre-`--repeat` order byte-for-byte, and that the record never claims the legacy design.
  regressInterleavedSchedule,
  regressExecutionOrder,
  regressPositionConditionalStates,
  REGRESS_ORDER_SCHEME_SINGLE,
  REGRESS_ORDER_SCHEME_INTERLEAVED,
  REGRESS_ORDER_LEGACY,
  REGRESS_ORDER_BASIS,
  REGRESS_ORDER_RESIDUAL,
  // PER-STEP MODE. `resolveStepScope` and `assertGateStepExists` are exported for the same reason: UNDEFINED is a
  // distinct state and the I26 group asserts it is reached and is never reachable as a FAIL.
  resolveStepScope,
  resolveStepFlag,
  assertGateStepExists,
  // THE CENSUS. Exported so the I27 group asserts the REAL cascade, the REAL monotonicity derivation and the REAL
  // refusal. Every one of these is a pure function of a matrix, which is what makes INCONCLUSIVE testable without a
  // repository and what keeps a second implementation of any of them from being possible by accident.
  censusClassifyTransition,
  censusRegions,
  censusTransitions,
  censusCandidates,
  censusMonotonicity,
  censusRefusal,
  censusUnresolvedBlock,
  censusResolveRange,
  censusStepPackage,
  censusIsTestPath,
  censusAddedExports,
  censusForeignPackageExports,
  censusErrorSignature,
  censusRangeBinding,
  CENSUS_CASCADE,
  CENSUS_CASCADE_IDS,
  CENSUS_STATES,
  CENSUS_HOLE_STATES,
  CENSUS_MONOTONICITY_STATES,
  CENSUS_MONOTONICITY_SCOPE,
  CENSUS_MONOTONICITY_BASIS,
  CENSUS_NO_INFORMATION_BASIS,
  CENSUS_MAX_COMMITS,
  CENSUS_MAX_COMMITS_BASIS,
  CENSUS_ERROR_MODES,
  CENSUS_CLASSIFICATION_BASIS,
  CENSUS_NOT_A_SEARCH,
  CENSUS_TRANSITION_NOT_A_CAUSE,
  CENSUS_LIMITATIONS,
  CENSUS_REFUSAL_NAMES,
  CENSUS_EXIT_NO_FINDING,
  CENSUS_EXIT_FINDING,
  CENSUS_EXIT_USAGE,
  CENSUS_EXIT_COMMIT_ERROR,
  CENSUS_EXIT_UNDETERMINED,
  CENSUS_EXIT_RULE,
  CENSUS_EXIT_BASIS,
  CENSUS_REPLAY_FIDELITY,
  CENSUS_ROW_FIELDS_NOT_PERSISTED,
  STEP_SCOPE_STATES,
  STEP_SCOPE_UNDEFINED_BASIS,
  STEP_SCOPE_FAIL_FAST_BASIS,
  STEP_SCOPE_LEDGER_EFFECT,
  REGRESS_ENVIRONMENT_FIELDS,
  REGRESS_EXIT_CLEANUP_FAILED,
  REGRESS_EXIT_FINDING,
  REGRESS_EXIT_INCONCLUSIVE,
  REGRESS_EXIT_NO_FINDING,
  REGRESS_EXIT_PRECEDENCE,
  REGRESS_EXIT_RULE,
  REGRESS_EXIT_SIDE_ERROR,
  REGRESS_EXIT_USAGE,
  REGRESS_GATE_EXECUTION_LIMIT,
  REGRESS_INVOCATION_LENGTH,
  REGRESS_LIMITATIONS,
  REGRESS_RUN_ORIGIN_KIND,
  REPEAT_ANTI_CONSERVATIVE_BASIS,
  REPEAT_BOUND_METHOD_EXACT,
  REPEAT_BOUND_METHOD_ZERO,
  REPEAT_BOUND_NOT_A_LICENCE,
  REPEAT_CLASSIFICATION_RULE,
  REPEAT_CONFIDENCE,
  REPEAT_DEFAULT_TRIALS,
  REPEAT_EXCHANGEABILITY,
  REPEAT_LIMITATIONS,
  REPEAT_MAX_TRIALS,
  REPEAT_NON_RESOLVING,
  REPEAT_RULE_CONTRADICTION,
  REPEAT_RULE_IDS,
  REPEAT_RULE_UNANIMOUS,
  REPEAT_TRIALS_LOG_SCHEMA_VERSION,
  REPEAT_UNATTAINABLE_BASIS,
  REPEAT_VERDICT_BASIS,
  REPEAT_VERDICT_BASIS_TEXT,
  REPEAT_VOTE_FORBIDDEN,
  classifyRegressTrials,
  regressAggregateDecisionSide,
  regressBinomialTailAtLeast,
  regressLogBinomialCoefficient,
  regressInvertBinomialTail,
  regressBoundExactness,
  REGRESS_TAIL_RESIDUAL_MAX,
  REGRESS_ZERO_FLIP_EXACTNESS_BASIS,
  REPEAT_ANTI_CONSERVATIVE_EVIDENCE_BASIS,
  countTreeEntries,
  PACKAGE_PATH_FIELDS,
  declaredPathValue,
  declaredExportsValue,
  undeterminedEntrypointFields,
  BUILD_PLAN_UNDETERMINED_BASIS,
  BUILD_ESCAPE_UNOBSERVED,
  BUILD_ESCAPE_BASIS,
  boundedDirectoryNames,
  buildEscapeRoots,
  beginBuildEscapeObservation,
  finishBuildEscapeObservation,
  WORKSPACE_STATES,
  workspaceAttestationStateIsKnown,
  historicalBuildPlanForCommit,
  declaredEntrypoints,
  regressBoundRecord,
  regressBoundTightened,
  regressFlipRateUpperBound,
  regressReadTrialLog,
  regressRepeatLines,
  regressResolveSession,
  regressResolveTrials,
  regressTrialRecord,
  regressTrialsLogPath,
  withRegressAggregateBasis,
  REGRESS_SIDE_STATES,
  REGRESS_VERDICTS,
  REGRESS_VERDICT_BASIS,
  REGRESS_VERDICT_BASIS_TEXT,
  computeWorkspaceKey,
  constructChildEnv,
  createGateLogWriter,
  createWriter,
  detectPrimaryCheckoutChange,
  envFacts,
  initializeLedger,
  inspectLedgerInventory,
  isContainedBy,
  judgeCommitProbeNames,
  mutateLedger,
  npmSupportedLockfileVersions,
  observeInstalledState,
  observeNode,
  observePrimaryGitConfig,
  observeResolverProbe,
  packageManagerRecord,
  parseStrictJson,
  probeResolvesInsideWorkspace,
  resolveControlPath,
  resolveExternalOutputPath,
  resolveWorkspaceRoot,
  validateOperationalLedger,
  verifyReusableWorkspace,
  workspaceNodeModulesPaths,
  observeResolverNegativeControl,
  observeInstalledTreeFingerprint,
  classifyResolverProbe,
  resolverProbeProblems,
  historicalInstallScriptFacts,
  treeFingerprintTierOrFail,
  TREE_FINGERPRINT_TIERS,
  TREE_FINGERPRINT_LIMITS,
  TREE_FINGERPRINT_STANDING_LIMIT,
  RESOLVER_NEGATIVE_CONTROL,
  GATE_ENV_POLICIES,
  GATE_ENV_DEFAULT_POLICY,
  // F-2: ONE refusal payload and ONE boundary check for `--gate-env`, so `census`, `evaluate`, `regress` and
  // `workspace prepare` cannot drift apart on why they refuse. Asserted in `E28-02` and in invariant group `I30`.
  GATE_ENV_REFUSAL_NAME,
  GATE_ENV_REFUSAL_BASIS,
  unknownGateEnvPolicyRefusal,
  assertGateEnvFlagValue,
  FINGERPRINT_REFUSAL_NAME,
  unknownFingerprintTierRefusal,
  assertFingerprintFlagValue,
  // F-1: THE HEAD, as an ordered list with a COMPUTED byte floor, replacing the false "first 200 bytes" claim that
  // was carried in the code comment and published in three documents.
  VERDICT_HEAD_FIELDS,
  verdictHeadByteFloor,
  writeNewFileExclusive,
};
