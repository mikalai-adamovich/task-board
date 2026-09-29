# Execution-state ledger

**Purpose:** durable execution state for a task run. It is **not** memory, not semantic search, not a database, and not
a replacement for `AGENTS.md` — it is the smallest state a coding task needs to survive a context break. The harness can
evaluate it separately, but that result is not independently authenticated.

---

## 1. Three separate things

| Thing                 | Who produces it                                                                        | Where it lives                                                                   | Counts as evidence?         |
| --------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| **Claim**             | the agent (prose)                                                                      | `ledger.claims[]` and the run's `agent_claim` event                              | **no**                      |
| **Execution state**   | the agent + the evaluator                                                              | `ledger.status`, `completed[]`, `pending[]`                                      | no (it is state, not proof) |
| **Transition record** | the CLI path that changes `ledger.status`                                              | `ledger.transitions[]`                                                           | no (observability only)     |
| **Evidence**          | supported evaluator path after its gate path; same-principal writers may forge entries | `.harness/state/runs/<run>.jsonl` (`verification_*`) and `ledger.verification[]` | **yes**                     |

The supported `harness evaluate` CLI appends `ledger.verification[]` only after following its gate path. This is not an
at-rest writer restriction: a same-privileged direct write can create a shape-valid entry, and persisted evidence is not
authenticated as execution. Writing prose into the ledger never turns it into evidence.

## 2. Where it lives

```
.harness/state/ledgers/<run_id>.json     one file per run
```

`ledger` (current durable state) vs `runs/` (append-only event history): the JSONL stays the evidence stream; the ledger
is the state snapshot derived from it plus agent-recorded work. They are not duplicates — the ledger holds no gate
output and the JSONL holds no lifecycle.

## 3. Schema (v1)

```json
{
  "version": 1,
  "run_id": "run-example",
  "task_id": "TASK-EXAMPLE",
  "arm": null,
  "title": "…",
  "source_commit": "37888f2",
  "workspace": ".",
  "gate": { "name": "check", "compatibility": "gate_compatible", "checked_at": "…", "problems": [] },
  "status": "verification_pending",
  "transitions": [
    {
      "at": "…",
      "from": "pending",
      "to": "verification_pending",
      "source": "evaluator",
      "cause": "harness evaluate",
      "run_id": "run-123",
      "reason": "…"
    }
  ],
  "acceptance": ["criterion 1", "…"],
  "acceptance_verdict": "unknown",
  "completed": [{ "at": "…", "text": "…", "source": "agent" }],
  "pending": [{ "at": "…", "text": "…", "source": "agent" }],
  "claims": [{ "at": "…", "text": "…", "source": "agent" }],
  "verification": [
    { "at": "…", "gate": "check", "exit_code": 0, "duration_ms": 41800, "mechanism": "evaluator", "steps": [] }
  ],
  "resolved_pending": [{ "at": "…", "text": "…", "resolved_by": "…", "resolved_at": "…" }],
  "failures": [{ "at": "…", "category": "lint_failure", "source": "gate" }],
  "invalid_transitions": [{ "at": "…", "attempted_status": "verified", "reason": "…" }],
  "blockers": [
    { "at": "…", "kind": "acceptance_coverage_incomplete", "text": "…", "source": "evaluator", "run_id": "…" }
  ],
  "verifier": {
    "at": "…",
    "verdict": "PASS",
    "artifact_integrity": "UNCHANGED",
    "criteria_checked": ["A1"],
    "findings": [{ "requirement": "…", "mechanism": "…", "evidence": "file:line | command output" }],
    "evidence": ["…"],
    "source": "flags",
    "authority": "advisory: the evaluator owns terminal state; FAIL forces failed, PASS cannot promote"
  },
  "created_at": "…",
  "updated_at": "…"
}
```

`transitions[]` is **additive and optional** (STATE-MODEL). Each entry records an actual status change as
`{ at, from, to, source, cause, run_id, reason }`: ISO timestamp, previous and new status, `evaluator` or `agent`
source, the CLI path that caused the change (`harness evaluate` or `harness ledger set`), the evaluator run id when a
run caused the change, and an optional bounded reason. `ledger init` starts with `transitions: []`; `ledger set` and
`evaluate` append only when the durable status actually changes. `run_id` is bounded to 200 characters and `reason` to
400; there is at most one entry per actual status-changing CLI invocation.

A ledger written before STATE-MODEL has no `transitions` field. Readers treat it as **not recorded**, never infer a
history from other fields, and do not migrate or rewrite the file. `harness ledger show --json` exposes the missing
field as `null`, and the human view says `not recorded`.

`evaluations[]` is **additive and optional** (commit binding). A ledger written before it has no such field; readers
treat it as **not recorded** and never infer a judged commit from `verification[]`, from `source_commit`, or from the
current HEAD of any workspace. `ledger init` seeds it as `[]`; `harness evaluate` appends one entry in exactly the same
conditional that appends `verification[]` — a gate-bearing, gate-compatible, ledger-attached run — so a no-gate,
gate-incompatible, unledgered, or interrupted run appends nothing and the record never claims a judgement that did not
complete. The array is bounded at 10 000 entries like every sibling array, and every optional observation is written as
`null` rather than omitted, so the writer and the reader can never disagree about the shape.

`blockers[]` and `verifier` are **additive** (Durable-state behavior). A ledger written before Durable-state behavior
has neither; readers treat a missing field as "not recorded" (`verifier: null`, `blockers: []`) and never infer a value.
`acceptance_checks` (Structural behavior) now also carries `criteria[]` — the per-criterion coverage state — and
`coverage_state`.

`acceptance` is a read-only copy of the task contract — the ledger carries the criteria so a fresh process does not need
the conversation to know what "done" means.

## 4. Lifecycle

```
pending ─► in_progress ─► verification_pending ─► verified
                              │
                              ├─► failed     (gate ran and failed)
                              └─► blocked    (gate incompatible, or pending work remains)
```

`verified` requires: mechanical gate pass **and** `acceptance_verdict = pass`. A passing gate with an unjudged
acceptance stays at `verification_pending` — deliberately, so "gate passed" is never reported as "task done".

**Pending rule (deterministic):** when the evaluator records a **passing** verification, `pending[]` is emptied and its
items are archived into `resolved_pending[]` with `resolved_by` (run id) and `resolved_at`. A failing verification
leaves `pending[]` untouched. `unresolved_pending` is reported at `verification_pending`, `verified` and `failed`, so a
stale item is visible before the task reaches a terminal status.

**Claims:** a claim supplied to `harness evaluate` (`--claim`) is appended to `claims[]` with `source: "agent"` — the
same array the agent can write with `ledger set --claim`. It is never copied into `verification[]`.

## 4a. Current-fact terminal derivation and no-gate observations (S4)

A loaded ledger is not a terminal input. The classifier accepts only current gate result, current acceptance and
coverage, current verifier facts, and a normalized integrity-veto enum derived from the same identity-valid selected
ledger. Loaded status, transitions, pending/completed/claims/failures, prior acceptance/verifier snapshots, gate and
workspace snapshots, run sequencing, prior contract/policy copies, persisted human/verifier records, report/selection
state, persistence markers, and prior publication artifacts cannot promote, redirect, veto, or clear a new result.

The 12 durable families are therefore non-causal **by interface construction**, not twelve field-specific classifiers.
The only durable exception is an unresolved `artifact_integrity_changed` blocker on the same selected ledger. It is
normalized to `unresolved` and may block a gate-bearing success; it can never promote. Omission does not clear it. A
current direct `UNCHANGED` observation on a gate-bearing run may normalize it to `cleared_by_current_unchanged`; no-gate
`UNCHANGED` cannot clear it.

A completed no-gate observation records the existing null-gate run fields but no `ledger_status`, emits no
`ledger_updated`, does not mutate the attached ledger, and exits `1`. Current verifier `FAIL` is the exception that
records `failed`; current artifact `CHANGED` records `blocked` plus the integrity blocker. Both remain fail-closed and
exit `1`. A refused attachment is not a run and is never written back.

This is a **qualification** of the supported local evaluator, not prevention of the same-principal class. A writer that
controls the current gate, contract, acceptance policy, direct verifier input, dependencies, evaluator, or downstream
consumer can still manufacture a fresh local `verified` result. Identity, schema validation, classifier narrowing, and
the negative integrity veto do not authenticate authorship or intent.

## 5. Inform vs govern

- **Inform** — `harness ledger show --task=<id> [--run-id=<id>] [--json]` prints the state a fresh process needs: task,
  source commit, acceptance criteria with their per-criterion coverage state, completed, pending, claims, verification
  history, status-transition history, failures, blockers, verifier evidence, invalid transitions and state-quality
  issues. It works with no access to any conversation. An interrupted-to-resumed sequence can therefore be reconstructed
  from the final ledger alone.
- **Inform, commit binding** — the same command renders the **declared** `source_commit` (frozen at `ledger init`, a
  diff base) and the **observed** judged commit of the newest `evaluations[]` entry as two separately labelled values,
  states explicitly when no judged commit was recorded, and states that default selection is by `updated_at` and run id,
  not by commit. In `--json` the observation is its own top-level `judged_commit` key, never a field of `ledger`.
  Without this the exact original misreading stays available: a result produced at commit B displayed next to commit A
  with a green status. `harness report` does the same per ledger row. Display only: no status, exit code, enum, schema
  shape or classifier input depends on it, and a declared/observed mismatch is recorded, never blocking.
- **Non-causal and untrusted observability** — `transitions[]` is a record of how the ordinary writable JSON file
  reached its current `status`; it is **not authority**. Classification, coverage, acceptance, blocker derivation and
  the acceptance pipeline never read it, and it cannot change a status, verdict or blocker. The ledger has no hash
  chain, signature, tamper evidence or at-rest protection: a writer with ordinary filesystem access can rewrite any
  entry. The history therefore supports sequence reconstruction, not proof that the sequence was not altered.
- **Non-causal and untrusted observability (commit binding)** — `evaluations[]` is a record of ONE invocation's observed
  tree state: the commit that was judged (full 40-hex, pre and post), the directory the gate ran in, the tree's scope,
  the working-tree digest before and after, the resolved gate name and its definition digest, the contract digest and
  the lockfile digest. It is **not authority** and it is placed here, beside `transitions[]`, deliberately: it is **as
  writable as `verification[]`**, and a same-principal writer can write a `judged_commit` that was never judged. It
  cannot change a status, verdict, blocker or exit code, and no decision path reads it. An `evaluations[]` entry is
  **not a reproduction recipe** and does not establish that a run is reproducible, deterministic, or that the gate ran
  against the dependencies or the evaluator of that commit; two equal observations are two samples, not a proof. It
  joins `verification[]` by `run_id` and introduces no new identity. `judged_commit` is a fact about the local object
  database of the resolved workspace: it carries no claim about any remote and none that the commit was ever pushed.
- **Non-causal and untrusted observability (environment provenance)** — `environments[]` is a record of ONE invocation's
  observed local environment: the declared source commit beside the observed judged commit, how the dependencies were
  provisioned, the installed tree's topology and containment scope, a digest of npm's own account of what it installed,
  a bounded resolver probe of the absolute paths Node actually chose, the toolchain that ran, and a digest of the child
  environment the harness constructed. It is **not authority** and it is placed here for the same reason `evaluations[]`
  is: it is **as writable as `verification[]`**, and a same-principal writer can write a provenance record that was
  never observed. It cannot change a status, verdict, blocker or exit code, and no decision path reads it. An
  `environments[]` entry is **not a reproduction recipe**; it establishes neither reproducibility nor determinism, nor
  dependency authenticity. `installed_state_digest` is a **declaration by npm**, not an independent observation of the
  bytes. "Observed" means _this local program looked_, not that a lie requires a writer. **A worktree is not a security
  boundary, and historical reproducibility is not result authenticity.** It joins `verification[]` by `run_id`, and a
  ledger written before this field existed has no `environments` key and reads as "not recorded" — never as an error. It
  **cannot retroactively exonerate or condemn any run recorded before it**. It is bounded by count **and** by serialised
  bytes against the ledger size limit, with the eviction recorded in `bounded_reason`. See [`schemas.md`](schemas.md)
  §"Environment provenance records".
- **Build state and the historical build (additive, non-causal)** — an `environments[]` entry also carries the BUILD
  half of how the workspace was prepared and what its source tree contained when the gate ran: `historical_build_mode`
  (`derived` / `declared` / `disabled` / `null` for an `evaluate` that performed no build), `historical_build_command`
  and `historical_build_command_basis` (the command is read from the **judged commit's own** manifests, or is a
  **declared** `--build-command` input, or the step was disabled), `historical_build_outcome` / `_exit_code` /
  `_duration_ms` / `_packages`, and `historical_build_executed_arbitrary_scripts` — permanently **`null`**, with a basis
  saying why, and never `true`: a build **executes the historical commit's own `build` string with no neutraliser**,
  which is a strictly larger class of script than the install's. `build_state` is the observation of the gitignored
  **source-tree** build outputs the gate depends on, with `build_state.observed: false` meaning the state **could not be
  observed** (never "there is no build output") and `build_state_limitation` stating that it is an **observation of
  bytes, not a content pin**. Ignored path **names** are recorded; a gitignored secrets file such as `server/.dev.vars`
  is named because git names it, and its contents are never opened, hashed, digested or recorded.
  `installed_tree_fingerprint_exclusions` records the walk's explicit exclusion set (`[".vite", ".cache"]`) with its
  version and what was actually excluded, and the recorded limitation says the cost: every byte under those paths is
  **UNATTESTED** for the lifetime of that workspace. None of these fields is read by any decision path, none changes a
  status, verdict, blocker or exit code, and a ledger written before them reads as "not recorded".
- **Govern** — the evaluator enforces transitions:
  - `verified` / `failed` are **evaluator-only**. `harness ledger set --status=verified` is refused and the attempt is
    recorded in `invalid_transitions[]`.
  - verification entries are written only after the gate actually runs.
  - a gate that cannot execute at the workspace's commit yields `gate_compatibility: gate_incompatible`,
    `status: blocked`, no verification entry, and `false_done` stays false — it is a setup failure, not an agent
    failure.
  - **fail-closed coverage (Durable-state behavior).** A green gate with an acceptance criterion that no discriminating
    predicate evaluated — uncovered, or a predicate that could not decide — lands in `blocked`, never `verified`, and
    records a `blockers[]` entry naming the criteria. A human verdict (`--acceptance=pass|fail`) remains the way to
    judge them.
  - **verifier evidence is advisory (Durable-state behavior).** `ledger.verifier` is recorded, never authoritative: a
    `FAIL` verdict forces `failed` even when the gate passed and acceptance passed; `PASS` cannot promote anything by
    itself; a verdict whose `artifact_integrity` is `CHANGED` is unusable and blocks the run; `UNKNOWN` is preserved as
    `UNKNOWN`. Hashing is a **detective** control — it detects a changed artifact, it does not prevent one.
  - **integrity clearance is invocation-local (Recorded-block persistence / S8 correction).** Once a ledger records an
    `artifact_integrity_changed` blocker, a later evaluation cannot reach `verified` by simply not consulting a
    verifier. A run supplying fresh `--artifact-integrity=UNCHANGED` with an `--artifact-integrity-basis` can normalise
    the veto for that invocation, exit 0, and record an `integrity_clearances[]` entry (`computed | declared`), but the
    persisted blocker remains. `hasUnresolvedIntegrityBlocker()` currently ignores recorded clearances, so the next run
    without `UNCHANGED` is blocked again. Coverage blocks are re-derived while a criterion still lacks a discriminating
    predicate.

The append-only behaviour applies within the CLI contract. It is not a tamper-resistant append-only store: normal JSON
writes still replace the file, and historical entries are not protected against direct edit or rollback.

## 6. State-quality checks

Computed by `ledger show` and aggregated into `results/baseline.json` under `ledger_state_quality`:

| Kind                                     | Meaning                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contradictory_state`                    | `verified` with no passing verification entry, or `pending` with completed work                                                                         |
| `missing_state`                          | verification evidence exists but no claim was recorded                                                                                                  |
| `stale_state`                            | workspace HEAD differs from `source_commit` and NOTHING has ever been verified — no `verification[]` entry and no `evaluations[]` entry                 |
| `invalid_verification_transition`        | an attempt to set an evaluator-only status was rejected                                                                                                 |
| `unresolved_pending`                     | pending items remain at a terminal status                                                                                                               |
| `result_unbound`                         | the newest `evaluations[]` entry recorded **no observed judged commit**: that result is not bound to a commit                                           |
| `declared_not_judged`                    | **entry versus entry** — the newest `evaluations[]` entry's own `declared_source_commit` does not match that same entry's own `judged_commit`           |
| `evaluation_environment_commit_mismatch` | **array versus array** — the `environments[]` entry for that same `run_id` names a commit that is neither of the two the `evaluations[]` entry observed |
| `environment_run_unbound`                | the ledger records environment entries, but none for the `run_id` the newest `evaluations[]` entry names                                                |

The commit-binding kinds are computed **only** from the newest run that actually produced an `evaluations[]` entry,
identified by its `run_id`. A run that appended none — `--no-gate`, `gate_incompatible`, or a run with no attached
ledger — triggers **none of them**. `stale_state` keeps its original "nothing was ever verified here" scope, so a ledger
that has judged something reports its judged commit instead. All of them are record-only: free-form `{kind, detail}`
with no enum, and none can change a status, an exit code, or a classifier input. The divergence between the ledger's
frozen `source_commit` and an entry's run-time `declared_source_commit` (a contract edited after `ledger init`) is
**not** detected by any kind, and no kind claims it is.

`evaluation_environment_commit_mismatch` exists because `evaluations[]` and `environments[]` are appended by the **same
run under the same conditional**, so their judged commits must agree. Without it, a cross-wired pair
(`evaluations[0].judged_commit_pre = B` beside `environments[0].judged_commit = A`, both in vocabulary) rendered as two
unflagged, differently-labelled OBSERVED facts side by side — the exact shape a reader cannot check by eye. This is
**defence in depth**: it catches a **buggy writer** as readily as a tamper, and it authenticates nothing. Forging both
arrays consistently remains the declared same-principal limitation.

## 6a. Concurrent writers, and why the write is a compare-and-swap

Publication is atomic — temp file, `fsync`, `rename` — so no TORN file is ever read. That is not the same as durability
of an **update**: the mutation is a read-modify-write, so two concurrent runs on one ledger read the same bytes, both
rename, and the slower one silently erases the faster one's `verification[]` entry, its transition and its `failed`
status, while the losing run's own JSONL still says `ledger_status: failed`.

Each writer therefore captures the digest of the bytes it **read**, before the gate runs, and the write happens **if and
only if** the file on disk is still exactly those bytes. Anything else is a `LEDGER_WRITE_CONFLICT` **refusal**, exit 1:
never a silent overwrite, and never a merge the operator did not ask for. The refusal says plainly that the
`ledger_status` in that run's own stream was not published.

A **lock file was deliberately not chosen.** A lock has to be cleaned up on every path including a crash, and a stale
lock has to be recoverable, or the wedge simply moves from "lost update" to "permanently busy ledger" — strictly worse,
because a lost update at least leaves a trace in the run stream. The compare-and-swap takes no lock, holds no lock and
expires nothing, so **it cannot deadlock the ordinary single-writer path**, whose behaviour is byte-for-byte unchanged,
and a lost update is impossible rather than unlikely.

This is a **concurrency** property, not an authenticity one. A same-principal writer can still write the file directly,
and the conflict is decided by file bytes alone.

## 7. Strict operational loading, inventory, and forensic history

A ledger is operational only when its exact bytes pass the bounded strict parser and the fully explicit schema in
[`schemas.md`](schemas.md) §7, and requested run ID = filename stem = embedded `run_id` while embedded `task_id` equals
the selected task. The reader never repairs or normalises the file. Unknown sibling keys are tolerated and remain data;
a known key with the wrong type, enum, bound, required nesting, or timestamp is invalid. Duplicate keys are invalid at
every depth. Input is capped at 1,048,576 bytes and depth 32.

Operational refusal exits 2 before run, gate-log, telemetry, or ledger creation. Inventory applies this precedence:

1. unreadable/non-regular, oversize, invalid UTF-8/JSON, duplicate key, too deep, or non-object root → `rejected`;
2. parseable filename/embedded/task identity mismatch → `forensic_only`, even with additional shape diagnostics;
3. identity-matching known-field error → `rejected` with `LEDGER_SHAPE_INVALID`;
4. otherwise → `operational_valid`.

Default `ledger show` and `ledger set` selection considers only `operational_valid` rows for the exact task, sorts by
`updated_at` descending, then uses `run_id` descending as a deterministic tie-breaker. Reports publish all inventory
rows but compute state quality only for operational-valid rows.

Parseable identity mismatches remain available through `ledger forensic`, which dispatches before task lookup and
forbids `--task`. It can print bounded metadata, JSON metadata, or exact raw bytes in 64 KiB chunks. JSON contains
`mode: forensic_observation`, `causal: false`, path/length/SHA-256/parse/identity/diagnostic facts, and a non-causal
statement; it contains no ledger status, suitability, terminal, or verification field. Raw input is capped at 16,777,216
bytes. The command itself never calls the classifier, state-quality reader, writers, mutator, attachment path, or
terminal selector. This exclusion is path-local, not content provenance: exact bytes copied to an identity-matching
filename can become operational. These controls are same-principal hardening, not isolation.

## 8. Manual inspection

```bash
node .harness/runtime/harness.mjs ledger show --task=<id>                    # newest operational ledger
node .harness/runtime/harness.mjs ledger show --task=<id> --run-id=<run>    # specific operational ledger
node .harness/runtime/harness.mjs ledger show --task=<id> --json            # machine-readable + state quality
node .harness/runtime/harness.mjs ledger forensic --run-id=<run> --json     # non-causal mismatch/shape facts
node .harness/runtime/harness.mjs ledger forensic --run-id=<run> --raw      # exact bounded raw bytes
```

## 8a. Historical workspaces and their attestations

`harness workspace prepare` writes `.harness/state/workspaces/<key>.<instance>.json`. That file is **operator state, not
evidence**: it is not a ledger, it enters no denominator, it reads no decision path, and it is gitignored so
`git status --porcelain` (and therefore `status_hash_pre` / `status_hash_post`) does not move because of it. A `usable`
attestation is a _local re-usability_ claim about one directory — it says the commit, the topology and the
installed-state digest were re-verified on this machine, not that anything was authenticated. The worktree it describes
is a place on a filesystem: **a worktree is not a security boundary**, and the install that produced it executed a
historical manifest's lifecycle scripts with operator privileges.

## 8a-1. What a PER-STEP run does and does not do to a ledger

The same is true of the two capabilities that ride on it, because both are non-causal by construction:
`regress --step=<name>` composes with `--repeat` and with each trial's order, and the trial order is recorded in the
comparison artifact under `repeat.execution_order` (with `repeat.position_conditional` beside it as a disclosure, never
a classification input). Neither is read by a ledger, a denominator or a decision path; the full rules are in
[`schemas.md`](schemas.md) §2b.3a "Order-aware trial scheduling" and §2c.

**Nothing, and deliberately.** `evaluate --step=<name>` runs ONE named step of a gate, independently, with no fail-fast,
through the existing loop, the existing `runStep` and the existing run-stream events. It adds **no second ledger**: with
`--step` set, `updatesAttachedLedger` is `false`, so a per-step run appends **no** `verification[]` entry, **no**
`evaluations[]` entry, **no** `environments[]` entry, sets no `status`, and records no transition. The ledger is left
**byte-identical** and no `ledger_updated` event is emitted.

Why: one step is not the gate. A terminal state derived from a single step would be a whole-gate claim the run never
measured. The step and its provenance are still in the **run stream** (`step_scope` in the `gate_compatibility`,
`verification_started`, `verification_finished` and `run_finished` events) and on the **workspace attestation**
(`step_scope` + `whole_gate_compatibility`), which is where a per-step census reads them. Exit `0` still means "this run
mechanically verified the GATE", so a per-step run never returns `0`; no new exit code was minted, and
`classifyLedgerStatus`, the `verification[]` shape, the 15-key `evaluations[]` entry and the evaluate exit protocol are
unchanged.

A step whose script the **judged commit's own manifests** do not declare is `UNDEFINED`: nothing is spawned,
`gate_exit_code` is an explicit `null`, and a side measured that way is `INCONCLUSIVE` in `regress` — never `PASS`,
never `FAIL`, never a direction. **`UNDEFINED` is not a failure and never becomes one.** This is the same distinction as
the `UNDEFINED, not red` finding in [`schemas.md`](schemas.md) §2a.6: a commit that never declared a script has nothing
to fail, and a census that reported it red would be laundering an absence.

## 8b. What `harness regress` does and does not do to a ledger

**Nothing.** `regress` never opens a ledger for writing and never attaches one. It runs each side through the ordinary
`workspace prepare` + `evaluate` path **without** `--ledger`, so:

- no `status` is set, and no `ledger_updated` event is emitted;
- no `verification[]`, `evaluations[]` or `environments[]` entry is appended;
- no transition is recorded and no blocker is derived;
- `ledger show` and `report` are byte-identical before and after, and the task's `state_quality` kinds are unchanged.

**`regress` is a read-mostly, non-causal command with respect to LEDGER terminal state.** Its verdict is a printed and
recorded _observation_ about two named commits, and it is **not a task verdict**: it enters no **ledger-derived**
denominator, it is not a terminal state, and it is not one of the eight statuses the evaluator maintains. Two `regress`
runs over the same durable inputs produce the same verdict.

**It is not absent from `report`, and the docs say so rather than claim otherwise.** Each side is an ordinary
gate-bearing `evaluate` run and **is** counted in `report`'s totals; both carry
`run_origin = <regress_comparison>:<invocation_id>`, and `report` discloses the count as **`comparison_sourced_runs`**.
The existing denominators are **left exactly as they were** — removing comparison runs from them would silently redefine
what `report` has always meant — so the non-causality claim is made true by disclosure, not by subtraction.

Its own output is a **report artifact** under `.harness/state/reports/regress-<timestamp>.json`, written with the
existing exclusive-creation discipline and read by no decision path. Its exit codes are **command-local** (`0` no
finding · `1` a finding · `2` usage/refused · `4` a side is `ERROR` · `5` a side is `INCONCLUSIVE` · `6` a removal was
refused; **`3` is never emitted**), and they are never reinterpreted as evaluate's protocol.

The four side states and the comparison rules are specified in [`schemas.md`](schemas.md) §2a. The short form: `PASS`
and `FAIL` are what the gate did; `INCONCLUSIVE` means the side was measured but the measurement cannot decide (a
statement about the **evaluated state**); `ERROR` means a command could not be run to completion (a statement about the
**tool**). **`INCONCLUSIVE` is neither `PASS` nor `FAIL`**, is never counted as either, and never resolves a comparison
in either direction — the other side is never declared the winner.

## 8c. What `harness census` does and does not do to a ledger

**Nothing.** A census measures a RANGE, and every part of it is non-causal in the same way `regress` is:

- it attaches **no ledger**;
- it appends **no** `verification[]`, **no** `evaluations[]`, **no** `environments[]` entry;
- it sets **no** status, and it changes no byte of any ledger on disk;
- the monotonicity verdict, the failure regions, the candidates and the refusal are a **printed and recorded observation
  about a range**, never a task verdict.

Each commit's measurement is an ordinary `workspace prepare` followed by an ordinary `evaluate --step`, so a census
run's children **do** appear in `report`: `report` counts every gate-bearing run and discloses the comparison- and
census-sourced ones under `comparison_sourced_runs`, leaving every existing denominator unchanged.

The durable per-commit row is the **existing** append-only trial log — `regress-trials-<session>.jsonl`, one chain, one
head file, one reader, one byte bound. There is no census ledger and no second provenance format, which is why
`--census-session=<token>` resumes an interrupted census by **replaying** the rows already written, never re-running and
never rewriting them. A token is bound to a digest over the question it asked (`task_id`, `gate`, `step`, both refs,
both resolved commits, the environment policy and the fingerprint tier); resuming it against a **different** range,
step, task or policy is **refused by name**, before any workspace is prepared.

A ledger written before this command existed has no census fields and reads as **"not recorded"** — never as "clean".

## 9. Limitations

1. **Claims are human/evaluator-supplied text**, not an automatic capture of the agent's completion message.
2. **One task per ledger**, one run per file. No cross-session memory, no retention policy, no pruning.
3. **State quality is structural only** — it cannot detect a claim that is simply false when the gate passes.
4. **The ledger cannot prevent work**: `govern` currently refuses invalid verification transitions; it does not yet
   block redundant tool calls or stale reads (that would require the runtime, not this file).
5. **Transition history has no integrity guarantee** — it is useful for reconstruction when the file has not been
   rewritten, but ordinary writers can alter or remove it and no cryptographic mechanism detects that.
6. **Incompatible tasks are non-measurable, not failing** — they are excluded from baseline success rates.
7. Acceptance remains manual; no LLM judge is used.
8. **`harness regress` cannot distinguish a flaky acceptance predicate from a real difference.** A single observation of
   each side is one sample; two runs that agree are two samples, not a proof. `--confirm-disagreement` adds a second,
   explicitly non-authoritative observation and does not fix this.
9. **`harness regress` compares OBSERVED commits, never the contract's declared `source_commit`.** The declaration is a
   diff base frozen in the ledger; a result produced at one commit must never be read as a result for another, so an
   observed commit that is not the requested one makes that side `INCONCLUSIVE` rather than silently re-labelled.
10. **A worktree is not a security boundary, and historical reproducibility is not result authenticity.** A
    same-principal writer still controls the gate, the contract, the acceptance policy, the dependencies, the evaluator
    and this ledger. No field in a comparison artifact proves a result authentic.
11. **Automatic `git bisect` is a recorded NO-GO** and is not implemented — no command, no flag, no stub. See
    [`schemas.md`](schemas.md) §2a.5 for the four reasons and for the falsifier that would overturn it.
12. **`harness regress --repeat=N` is non-causal with respect to this ledger at every N, and a repeated comparison adds
    no ledger field at all.** Each trial is an ordinary gate-bearing `evaluate` run, and like any `evaluate` without
    `--ledger` it appends nothing: no `evaluations[]` entry, no `environments[]` entry, no `verification[]` entry, no
    status change. The trials live in the comparison artifact and in an append-only trial log under
    `.harness/state/regress-trials/`, which this ledger never reads. A ledger written before `--repeat` existed keeps
    loading and reads as "not recorded" for every repeated-evaluation field, because it has none.
13. **Repetition does not turn a sample into a proof.** `--repeat=N` classifies a side with the contradiction rule (any
    disagreement makes it `INCONCLUSIVE`; a vote is never taken) and prints the exact binomial bound together with
    `exchangeability: assumed, unverified`. A single observation still cannot distinguish a flaky acceptance predicate
    from a real difference between two commits, and more draws of the same predicate sharpen an estimate under an
    assumption the estimate itself cannot check. `INCONCLUSIVE` is NON-RESOLVING and is not git's `125`: it never skips,
    never narrows a search and never names the other side the winner. See [`schemas.md`](schemas.md) §2b "Repeated
    evaluation" — the title disambiguates, because `2b` is used twice in that file.
