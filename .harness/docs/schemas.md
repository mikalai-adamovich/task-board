# Schemas

> **Three heading NUMBERS in this file are used more than once**, and the document is deliberately NOT renumbered to fix
> that: `2b` ("2b. Repeated evaluation" and the later "2b. History census artifacts"), `2b.6` (the trial-log chain and
> "What repetition does NOT fix"), and `3` ("3. Aggregate results" and the later "§3 — The evaluate verdict"). A bare
> number reference therefore names whichever one a reader reaches first, so **every cross-reference to one of these
> numbers carries the heading TITLE as well** — the title and the number, never the number alone. The self-test enforces
> this: a bare-number reference to a number that resolves to more than one heading is reported as AMBIGUOUS and fails,
> rather than resolving silently.

Two artifacts: **task contracts** (versioned, hand-written) and **run events** (generated, JSONL, git-ignored).

## Authority interpretation — unauthenticated local qualification

Every persisted schema record, including a ledger or run event whose `status` is `verified`, is **unauthenticated
same-principal local qualification**. No field in these schemas should be read as a claim of trust, independence,
authenticity, protected authority, tamper evidence, or non-repudiation. A writer who controls the current gate,
contract, acceptance policy, direct verifier input, dependencies, evaluator, or a downstream consumer can still
manufacture a fresh local `verified` result. The harness cannot authenticate the writer, prove which contract or gate
was intended, prove the candidate stayed fixed, enforce an independent consumer boundary, or prevent evaluator rollback.

Schema validity, identity equality, a durable ledger status, exit 0, and report arithmetic describe bytes supplied to a
local program; they do not establish who wrote them, which policy was intended, or that a consumer will preserve this
interpretation. None of them closes the same-principal writer class.

## 1. Task contract — `.harness/state/tasks/<id>.json`

Required:

| Field           | Type     | Meaning                                                                                    |
| --------------- | -------- | ------------------------------------------------------------------------------------------ |
| `id`            | string   | Matches the file name (`TASK-S01.json` → `S01`). Stable, never reused.                     |
| `title`         | string   | One-line description of the change to be made.                                             |
| `category`      | string   | `server` · `ui` · `fullstack` · `i18n` · `rbac` · `test-infra`                             |
| `source_commit` | git sha  | The commit the run **starts from** — normally the parent of the commit that did this work. |
| `acceptance`    | string[] | Observable criteria used to judge the result. Behaviour, not implementation steps.         |
| `workspace`     | object   | `{ "primary": [paths], "secondary": [paths], "notes": "..." }`                             |

Optional:

| Field                   | Type     | Meaning                                                                                                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `size`                  | string   | `small` · `medium` · `large` — set from the original diff (`git show --shortstat`).                                                             |
| `verification`          | object   | `{ "gate": "check", "targeted": ["<npm script>"], "manual": ["<step>"] }`. Default `check`.                                                     |
| `constraints`           | string[] | Rules the run must respect (e.g. "do not touch the UI", "no schema change").                                                                    |
| `failure_modes`         | string[] | Categories from [`failure-taxonomy.md`](failure-taxonomy.md) expected to be plausible for this task.                                            |
| `history`               | object   | `{ "evidence": "<path>", "note": "..." }` — where this task came from.                                                                          |
| `schema_version`        | number   | Currently `1`.                                                                                                                                  |
| `acceptance_boundaries` | object[] | Criterion-boundary behavior: what mechanical evidence witnesses each criterion, and what authority supplies its acceptance evidence. See below. |

#### `acceptance_boundaries[]` (Criterion-boundary behavior, optional)

One entry per annotated criterion, ascending by `criterion` (the same 1-based index space
`acceptance_checks[].criterion` uses). Every field is optional at the contract level: a contract without the array keeps
an unknown boundary for every criterion, which is what all historical contracts mean.

| Field             | Type    | Values                                                                                                             |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `criterion`       | integer | `1..acceptance.length`                                                                                             |
| `boundary`        | string  | `AUTOMATED_SAFE` · `AUTOMATED_PENDING_VALIDATION` · `HUMAN_OR_HYBRID` · `NOT_AUTOMATABLE_WITH_CURRENT_OBSERVABLES` |
| `evidence_source` | string  | `AUTOMATED` · `HUMAN` · `HYBRID` · `UNAVAILABLE`                                                                   |

The value sets are the Structural behavior.2 per-criterion classification (reused, not re-invented) and the
acceptance-evidence authority. They answer different questions: `boundary` says whether a mechanical witness _can_
establish the criterion; `evidence_source` says where the acceptance verdict comes from today. Neither is a score, and
neither votes on a verdict.

Fail-closed rules (`harness validate`):

- an entry must carry at least one of `boundary` / `evidence_source`; unknown keys, out-of-range or duplicated criteria
  and out-of-vocabulary values are errors and are never normalised;
- `AUTOMATED_SAFE` requires a declared `acceptance_checks[]` entry for the same criterion, because the claim of _being_
  witnessed needs a witness. `AUTOMATED_PENDING_VALIDATION` means the opposite (a witness is conceivable but not
  established) and therefore does not;
- a criterion with no entry keeps an unknown boundary and an unknown evidence source. Missing is never inferred to be
  mechanical, and a missing `evidence_source` is never inferred to be `AUTOMATED`;
- nothing here changes coverage, the acceptance verdict or the ledger status: `deriveAcceptance` and
  `classifyLedgerStatus` do not read these fields.

Rules:

- A contract describes the **task**, not the solution. It must not contain the diff, the patch or step-by-step
  instructions.
- `acceptance` must be checkable by a human against the merged result; it must not depend on the original author's style
  choices.
- `source_commit` must exist in this repository (validated by `harness.mjs validate`).

## 2. Run events — `.harness/state/runs/<run_id>.jsonl`

Run and ledger filenames use the bounded token grammar `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`. Absolute identifiers,
traversal, nested paths, and symlinked control roots are refused. External report/telemetry export is the sole
exception: it accepts only a new canonical absolute target beneath an existing non-symlink parent and publishes with
exclusive creation. A target at or beneath the active harness control plane (`$HARNESS_HOME/state/control/`, which is
`.harness/state/control/` by default) is always refused. This is same-principal hardening, not isolation; check/use
replacement and stranded reservations remain risks.

The supported terminal-evaluation guard's default marker remains `.harness/state/control/terminal-evaluation.disabled`.
An explicit absolute `HARNESS_CONTROL_ROOT` redirects only that guard marker for hermetic fixtures; absent the variable,
the default marker path and all existing status/transition exit codes are unchanged.

One JSON object per line, append-only, in emission order. Every record carries `seq`, `event`, `ts`, `run_id`.

| `event`                 | Emitted when                                     | Key fields                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_started`           | The evaluator starts                             | `task_id`, `gate`, `gate_definition_sha256`, `source_commit`, `head_commit`, `branch`, `working_tree_dirty`, `commits_since_source`, `self_test`, `agent_claimed_done`, `agent_claim`, `runtime_metrics`, `environment`, `judged_commit`, `judged_commit_basis`, `judged_commit_scope`, `judged_cwd`, `status_hash_pre`, `contract_digest`                                                                                                           |
| `verification_started`  | Before each gate step                            | `gate`, `step`, `command`, `cwd`, `judged_commit`, `judged_commit_scope`                                                                                                                                                                                                                                                                                                                                                                             |
| `verification_finished` | After each gate step                             | `step`, `command`, `exit_code`, `duration_ms`, `output_tail` (last 20 lines, ≤2000 chars)                                                                                                                                                                                                                                                                                                                                                            |
| `acceptance_evaluated`  | Only with `--acceptance=auto`                    | `verdict`, `criteria_total`, `criteria_covered`, `coverage`, `checks[]`                                                                                                                                                                                                                                                                                                                                                                              |
| `verifier_recorded`     | Only when verifier evidence was supplied         | `verdict`, `artifact_integrity`, `criteria_checked[]`, `findings[]`, `source`, `authority`                                                                                                                                                                                                                                                                                                                                                           |
| `workspace_changed`     | After the gate (or immediately with `--no-gate`) | `source_commit`, `changed_files` (name-status, capped at 200), `changed_file_count`, `truncated`, `diffstat`                                                                                                                                                                                                                                                                                                                                         |
| `run_finished`          | At the end of evaluation                         | `gate_exit_code`, `aborted_after`, `steps[]`, `mechanically_verified`, `self_test`, `agent_claimed_done`, `acceptance_verified`, `acceptance_verdict`, `acceptance_criteria[]`, `acceptance_coverage_state`, `acceptance_uncovered_criteria[]`, `acceptance_coverage_incomplete`, `verifier`, `blocked_reason`, `task_success`, `false_done`, `failure_category`, `failure_source`, `judged_commit_post`, `status_hash_post`, `notes`, `duration_ms` |

### `cwd` names the directory the gate actually ran in

`verification_started.cwd` and `run_started.environment.cwd` record the **evaluated workspace** — the directory
`runStep` spawns the gate in — not the repository root. A `--workspace` evaluation therefore names the directory the
gate actually ran in, and its result is not readable as a result for the primary checkout's HEAD.

### Commit-bound evaluation records in the run stream (optional, additive)

| Field                                  | Emitted in                            | Meaning                                                                                                                    |
| -------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `judged_commit`                        | `run_started`, `verification_started` | the commit the gate is about to judge, observed in the evaluated workspace, pre-gate                                       |
| `judged_commit_basis`                  | `run_started`                         | single-valued `observed`. It is never `declared`: a declaration is `source_commit` and must not be relabelled              |
| `judged_commit_scope`                  | `run_started`, `verification_started` | `primary_repo` · `linked_worktree_of_this_repo` · `unrelated_tree` — or `null` when the tree cannot be resolved            |
| `judged_cwd`                           | `run_started`                         | the evaluated workspace, repository-relative when it is inside the repository                                              |
| `status_hash_pre` / `status_hash_post` | `run_started` / `run_finished`        | 12-hex digest of unfiltered `git status --porcelain`, before and after the gate                                            |
| `contract_digest`                      | `run_started`                         | 16-hex canonical digest of the acceptance criteria, the acceptance checks, the acceptance boundaries and the RESOLVED gate |
| `judged_commit_post`                   | `run_finished`                        | the same commit, re-read after the gate, so a tree that moved during the gate is visible                                   |

`judged_commit` is **full 40 lower-case hex, never an abbreviation**: a prefix is exactly what makes two commits
confusable. It is a fact about the **local object database of the resolved `--workspace`**; it carries no claim about
any remote and none that the commit was ever pushed. `status_hash_*` is comparable **only within the same git
repository**; across repositories, and across git versions whose `--porcelain` output has not been verified, it is
UNVERIFIED. `gate_definition_sha256` identifies the **gate definition**; it does not detect a harness edit outside the
`GATES` literal, including changes to acceptance, classification, or this schema.

#### What `status_hash_*` is, and what it cannot see

`status_hash_pre` / `status_hash_post` **is a digest of `git status --porcelain`, NOT a tree identity** and not a commit
identity. It is a **working-tree delta** digest. Measured on this repository:

| Situation                                                                     | `status_hash`                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| a clean tree                                                                  | `e3b0c44298fc` (the empty-string digest)       |
| one untracked derived artefact added                                          | `9b5eecbf4494` — it MOVES                      |
| a **commit change on a clean tree**                                           | **byte-identical** — it does NOT move          |
| a regenerated untracked build product (e.g. `ui/public/themes/manifest.json`) | it MOVES, with nothing about the code changing |

`git status` prints nothing in the third row, so no digest of its output can distinguish it. This is why the `regress`
side classifier pairs it with the **two judged-commit samples** and decides movement from those first: a gate that runs
`git checkout` mid-step leaves a clean tree, and a pre-only classifier read `status_hash_pre === status_hash_post`, saw
nothing move, and attributed the result to a commit the gate never ran against. A `tree_moved` decision is therefore a
**disclosure about the working tree**, never a statement that a commit stayed fixed, and the same regenerated-artefact
row means a `tree_moved` can also be degraded by a build product on either side of a commit boundary.

Two observations (pre and post) are **two samples, not a proof**: a gate that checked out and back between them is
invisible. See §7.2 for the durable `ledger.evaluations[]` record. Its non-causal placement is specified in
[`ledger.md`](ledger.md) §5.

#### MANDATORY reading rule for `evaluations[]`

> An `evaluations[]` entry is a record of ONE invocation's observed tree state; it is **not a reproduction recipe** and
> does not establish that a run is reproducible, deterministic, or that the gate ran against the dependencies or the
> evaluator of that commit. Two equal observations are two samples, not a proof.

What an entry does establish, and what it does not:

| Established                                                                                                                                        | NOT established                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| the commit observed immediately before and after the gate, full 40-hex, twice; which directory it ran in; the tree's scope; the resolved gate name | that the tree stayed at that commit throughout the gate (two samples, not a proof)                                         |
| the working-tree digest before and after the gate                                                                                                  | reproducibility or determinism of the run; nothing is repeated to measure either                                           |
| the digest of the contract that judged it, including the resolved gate                                                                             | that the dependencies were the judged commit's — see `environments[]` below, which is the record that can answer it        |
| the lockfile digest in the judged workspace                                                                                                        | that the evaluator was the judged commit's; `gate_definition_sha256` is a GATE-definition identity, not a harness identity |
| that a same-principal writer controls this field exactly as it controls `verification[]`                                                           | that the entry was not written by hand, back-dated, or replayed — there is no hash chain, signature or tamper evidence     |

**Two digest limits, stated rather than implied.** `contract_digest` equality is **not** contract identity: it
canonicalises `acceptance`, `acceptance_boundaries`, `acceptance_checks` and the resolved gate, with an absent
`acceptance_checks` and `acceptance_checks: []` digesting identically, and it deliberately **excludes `schema_version`**
so that a schema bump does not silently re-label unchanged criteria text as a different contract. Read it together with
`acceptance_contract_schema_version` and `gate` in the same entry, or it answers a weaker question than the name
suggests. `lockfile_digest` digests the lockfile **as committed in the judged workspace only**: it does **not** track
the installed dependency set, so it stays stable exactly when the installed tree changes. That is why the environment
record below exists.

### Environment provenance records — `ledger.environments[]` (optional, additive)

A lockfile digest records what the lockfile **declares**, never what is **installed**: a workspace that inherits another
tree's `node_modules` is invisible to it, and `lockfile_digest` is byte-identical for the contaminated run and the
correct one. `environments[]` is the record that can answer the installed question; without it the string `node_modules`
appears nowhere in a run record.

`environments[]` is a sibling of `evaluations[]` on the ledger root, appended under **exactly** the same conditional — a
gate-bearing, gate-compatible, ledger-attached run — and joined to `verification[]` / `evaluations[]` by `run_id`. It is
**not** appended for `--no-gate`, gate-incompatible, or unledgered runs; `E1-04` / `E2-02` assert a `--no-gate` run
leaves the ledger file byte-identical, and no existing assertion was edited to accommodate this field. The
pre-evaluation cases the design would have put here (a failed install, a refused workspace) are served instead by the
`environment_observed` run event and by the workspace attestation, neither of which is ledger state.

Every field is present on write and **every observation is nullable**: absent becomes `null`, never `''` and never
omitted, because `mutateLedger` does not validate on write while the reader fails closed — a writer/reader disagreement
reclassifies the ledger as `rejected` on the next read and removes it permanently from `newestLedgerForTask`,
`ledger show` and `report`.

#### `npm_config_files` — the config-FILE channel the environment sanitisation does NOT close

`npm_config_files` is additive and optional: a record written before this field existed reads as "not recorded", never
as an error. It is deliberately **not** in the reader's required field shape, because adding a required key would
reclassify every existing environment record as `rejected` on the next read.

It records the digests and paths of the **user** and **global** npm config files, whether npm would re-derive the user
one from `HOME` or was pointed elsewhere, and the registry npm actually resolved — asked only when a config file is
actually present, and asked with the same child environment the install and the gate received. **Values are never
recorded: only a digest and a path.**

**This is a RECORDED LIMIT, not a solved problem, and it is stated here rather than left for a reader to discover.** The
`sanitised` policy drops every `npm_config_*` / `NPM_CONFIG_*` **variable**, `NPM_CONFIG_USERCONFIG` included — but npm
re-derives `$HOME/.npmrc` from `HOME`, which passes through untouched. In other words:

a npm config file is a channel the environment sanitisation does not close.

A hostile user npmrc can therefore still redirect the registry of a run recorded as `gate_env_policy: "sanitised"`,
`deviation: null`. Closing it would mean refusing to run npm at all for any operator who has an npmrc, which is a
different product decision. What is guaranteed here is only that the channel is **named and digested in the record**, so
the run is no longer silent about it.

| Field                                                                           | Basis                                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`, `run_id`, `schema_version`                                                | —                                                                      | timestamp, the join key, and the record's schema version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `gate_bearing`                                                                  | —                                                                      | did a gate actually run in this invocation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `declared_source_commit` / `judged_commit`                                      | **declared** / **observed**                                            | the contract's declaration beside the commit observed in the workspace the gate ran in — never merged                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `workspace_key`, `workspace_instance`                                           | **observed**                                                           | the reuse key (commit + lockfile bytes + full node version + full package-manager version + platform + `.npmrc` digest + `npm_config_*` digest), and the per-invocation instance label                                                                                                                                                                                                                                                                                                                                                             |
| `workspace_root_source`, `workspace_root_digest`                                | **observed**                                                           | how the worktree root was chosen, and a comparable identity that does not disclose an operator home path                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dependency_provisioning` + `_basis`                                            | **observed**                                                           | `installed_historical` · `linked_from_primary` · `inherited_upward` · `present_unattested` · `escapes_workspace` · `absent` · `unresolved`; basis is `observed` or `unresolved` and a declaration is **never** promoted                                                                                                                                                                                                                                                                                                                            |
| `node_modules_topology` / `node_modules_scope`                                  | **observed**                                                           | `real_directory` · `symlink` · `partial` · `missing`; and `worktree_local` · `escapes_worktree` · `inherited_upward` · `none`, computed from `realpath` containment, never from a path string                                                                                                                                                                                                                                                                                                                                                      |
| `node_modules_realpath`, `installed_package_count`                              | **observed**                                                           | the real path and the top-level entry count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `installed_state_digest` + `_source`                                            | **declared by npm**                                                    | 16-hex digest of `node_modules/.package-lock.json` — npm's **own** record of what it installed, **not** an independent observation of the bytes, and it cannot see native build output. **It cannot see an in-place content change**: editing one byte of one installed file leaves it byte-identical, which is why it is a cheap independent signal and NEVER the reuse check. A `file:` directory dependency installs as a symlink, so npm's record of it and the tree walk both see the LINK, not the target's bytes                            |
| `installed_tree_fingerprint` + `_tier` / `_limitation` / `_basis`               | **observed** by this local program, at the named tier                  | 16-hex digest of a walk THIS harness makes of `node_modules`, with the tier stated in the same record. A **different field from `installed_state_digest` with a different basis**, never a repurpose of it, and `null` means "not computed", never "unchanged". See §Installed-tree fingerprint below for what each tier can and cannot detect                                                                                                                                                                                                     |
| `resolver_probe_resolved_outside` / `_resolved_nothing`                         | **observed**                                                           | the F3 split: `resolved_outside` is a name something OUTSIDE this workspace supplied; `resolved_nothing` is a declared name that resolved to nothing at all. They are different facts with different causes, recorded separately so a durable record never carries one reason for the other. `null` ("not observed") stays distinct from `[]` ("observed, and empty")                                                                                                                                                                              |
| `resolver_probe_negative_control`                                               | **observed**                                                           | a sentinel name that is not a declared dependency of anything, resolved with the same `require.resolve` and the same child environment. `observed: false` means it could not be observed at all, never "it resolved to nothing"                                                                                                                                                                                                                                                                                                                    |
| `resolver_probe`                                                                | **observed**                                                           | for up to 5 names from the judged commit's own manifest, the ABSOLUTE path Node actually resolved each to inside that workspace; `null` when no gate ran. This is the only field that catches upward inheritance, `NODE_PATH` poisoning, a missed symlink and a partially-installed tree                                                                                                                                                                                                                                                           |
| `install`                                                                       | **observed**                                                           | `mode` · `outcome` · `exit_code` · `duration_ms` · `offline` · `output_tail`, or `null` when no install was attempted by this run                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `package_manager`                                                               | name/version **observed** by path probe; `declared_field` **declared** | `name` · `version` (full, never major-only) · `resolved_from` · the commit's `packageManager` field · `declared_field_honoured` · `declared_field_conflict`                                                                                                                                                                                                                                                                                                                                                                                        |
| `node`                                                                          | version **observed**; `engines_node` **declared**                      | `version` · `major` · `minor` · `patch`; the commit's `engines.node`; and `engines_satisfied` **computed**, because `engines` is a warning by default and a run on the wrong Node exits 0                                                                                                                                                                                                                                                                                                                                                          |
| `platform`                                                                      | **observed**                                                           | `os` · `arch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `env`                                                                           | **observed** over the CONSTRUCTED child env                            | `vars_digest` · `count` · `allowlist_digest` (the `npm_config_*` names the harness set) · `excluded_names`/`_digest` · `module_resolution_vars_removed`/`_accepted`. **Values are never recorded** — one `npm_config_*` can carry a token                                                                                                                                                                                                                                                                                                          |
| `historical_install_executed_arbitrary_scripts`                                 | **never `true` in this build**                                         | `null`, always. npm does not report whether a lifecycle script ran and this harness does not observe one, so the honest value is "unknown" and the basis string says exactly that. The OBSERVABLE siblings beside it are `historical_install_scripts_policy`, `historical_install_ignore_scripts` and `historical_install_output_showed_script_output` — the policy this program applied, and whether the captured output showed script-shaped lines. A match is evidence that output appeared; its **absence is not evidence that no script ran** |
| `gate_env_policy`                                                               | **observed**                                                           | `sanitised` (the default for EVERY run, historical or not) or `inherited`. `sanitised` is the environment the harness constructs and digests into `env`; `inherited` hands the gate the operator's shell wholesale, is recorded as a `deviation`, and re-opens exactly the `NODE_PATH` hole `NODE_OPTIONS`/`NODE_PATH` sanitisation exists to close                                                                                                                                                                                                |
| `primary_git_config_hooks_path_before` / `_after`, `primary_git_config_changed` | **observed**                                                           | `<REPO_ROOT>/.git/config` snapshotted around the install, because this repository's `prepare: husky` writes `core.hooksPath` into the primary repository's shared config                                                                                                                                                                                                                                                                                                                                                                           |
| `deviation`                                                                     | **observed**                                                           | any justified departure from a literal install, always recorded rather than hidden                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bounded_reason`                                                                | —                                                                      | set when older records were evicted to stay inside the ledger byte budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

#### Installed-tree fingerprint — the reuse check, and its measured cost

`installed_state_digest` is npm's **account** of the tree: it sees truncation, and it cannot see an **in-place content
edit** (one byte changed in one installed file leaves it byte-identical). Reuse therefore also requires
`installed_tree_fingerprint`, an observation this program makes by walking the directory at a **recorded** tier.

**Measured cost** on this repository's real dependency tree (manifests staged into a throwaway root, `npm ci` from the
project's own lockfile under npm 12.0.1 — 53 398 walk entries, 856 MB, cold install **7 272 ms**):

| tier                 | cost               | detects                                                                                                                                                                          | cannot detect                                                                                                                                                                                                                           |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata` (default) | **213-246 ms**     | add, remove, rename, and any change of a file's size, mtime, ctime or permission bit. `ctime` is unforgeable, so an ordinary process cannot write content and leave it invisible | a content write leaving all four identical — not achievable from userspace (measured: Node's `utimesSync` cannot even restore the sub-millisecond mtime ext4 records) — and a rollback of the whole tree to a previously recorded state |
| `content` (opt-in)   | **3 039-3 121 ms** | any change to the path set, a symlink target, or a file's content, hashed byte for byte, with no dependence on any filesystem timestamp semantics                                | nothing this local program can read; and a `file:` directory dependency installs as a symlink, so the digest records the link target, not the target's bytes                                                                            |

Three consequences, stated rather than discovered:

- The **tier is part of the reuse key**, so a workspace attested under one tier can never be handed back under the
  other. The cost is that changing the tier moves every key, so a workspace prepared under a previous build is rebuilt
  rather than silently reused.
- **Fail closed.** If no tier can be computed, the workspace is not reusable and not usable. There is deliberately no
  silent downgrade to the cheaper walk.
- `evaluate` computes **no** fingerprint by default: it also observes the 912 MB primary checkout, and `--fingerprint`
  is an explicit opt-in there.

#### The walk's EXCLUSION set — explicit, recorded, and priced

The walk root is `<workspace>/node_modules`, and a **gate run writes inside it**: a real checkout of this project
acquires `node_modules/.vite/vitest` (the UI test run) and `node_modules/.cache/wrangler` (`server build`). Those are
TOOL-GENERATED CACHES, not installed bytes. They are excluded explicitly rather than silently, because a silent
population would make a gate run look like a changed install: exact content-tier reproducibility is an **install-only**
property, and a workspace that had run the gate once would be **refused** on the next `prepare` with
`installed_tree_fingerprint_changed`, so repeated evaluation and workspace reuse would be **mutually exclusive** — a
prepared historical workspace could be measured exactly once. The alternative is to let a genuine change be reported as
a changed population forever.

| field                                           | meaning                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `installed_tree_fingerprint_exclusions`         | the declared set: `[".vite", ".cache"]`, relative to `<workspace>/node_modules`                 |
| `installed_tree_fingerprint_exclusions_version` | the set's version (`1`); a change to the set changes the meaning of every digest taken under it |
| `installed_tree_fingerprint_excluded_paths`     | what was **actually** excluded in this walk (the paths matched, not the whole set)              |
| `installed_tree_fingerprint_limitation`         | the tier's own label **plus** the exclusion set and its cost                                    |

The **cost**, stated rather than absorbed: every byte under an excluded path is **UNATTESTED** for the lifetime of that
workspace — a change there is invisible to the fingerprint and is neither detected nor claimed to be. The set is exactly
the two MEASURED paths: not a prefix list, not a pattern, and not "anything that looks like a cache", so a sibling entry
such as `vite-utils` is still attested and a tool that writes its cache anywhere else is caught (a rebuild), not
silently ignored. The same set is applied to the installed-entry **count**, because that count is itself a reuse
condition; the raw count and the names the exclusion removed are recorded beside it (`installed_entry_count_raw`,
`installed_entry_count_excluded`) so the two can always be reconciled.

#### The historical BUILD step — what it does, and what it discloses

**Why the step exists.** A historical evaluation predicate can be **constant-red**: every commit FAILS at the same gate
step, so the predicate cannot distinguish a good commit from a bad one and carries no localisation information. The
operator view is in [the manual](../README.md#L370). In this repository the mechanism is exact and asymmetric, and it is
a property of the manifests rather than of any commit:

- `shared/package.json` resolves only through `./dist` (`main`, `types`, `exports`);
- `shared/` declares **no** `prepare` script, so `npm ci` never built it;
- `dist` is **gitignored**, so `status_hash` (a digest of `git status` **without** `--ignored`) does not move and
  `files changed: 0` is reported;
- [`server/tsconfig.json`](../../server/tsconfig.json) has **no** `paths` mapping, so it resolves through
  `node_modules/@task-board/shared` → `exports.types` → `./dist/index.d.ts`, while `ui/tsconfig.app.json` maps the same
  name straight to `../../shared/src/index.ts`. The UI typecheck would have passed and the server one could not.

The single variable that decides the verdict therefore lives outside every recorded field: the deciding bytes are in the
**source** tree, while the fingerprint digests `node_modules`. `prepare` therefore **builds** the workspace the gate
needs, and the build step is a first-class part of workspace preparation rather than an optional extra.

**The plan** (`historical_build_plan`, in the workspace attestation; `historical_build_plan_digest` in the reuse key). A
workspace package is built when **all four** hold, every input read from the judged commit's own manifests
(`git show <commit>:<workspace>/package.json`) — never from the contract, never from the primary checkout:

1. it declares a `build` script;
2. it declares at least one **relative** entrypoint (`main` / `types` / `typings` / `exports`);
3. at least one of those entrypoints is **not tracked** at that commit, i.e. the package is not built in a fresh
   checkout;
4. some other manifest at that commit depends on it by a **local** spec (`workspace:`, `file:`, `*`, or a range equal to
   the local version).

On this repository's HEAD the plan is **EMPTY**, and that is the correct derived answer rather than a broken one:
`shared/package.json` declares `main`/`types`/`exports` as `./src/index.ts`, a file that IS tracked at the commit, so
condition (3) fails and no package is resolved through a build output. `tsc --traceResolution` in `server/` agrees —
it resolves `@task-board/shared` to `shared/src/index.ts`. All three workspace packages are recorded as **skipped** with
the reason each was not selected, so "why was nothing built" is answerable from the record. The plan is a DERIVATION and
the rule is what is asserted, not this answer: a manifest that declares a build-output entrypoint is still selected, and
the self-test drives the real planner over a disposable repository to prove it. The order is deterministic: a dependency
before its dependents, name as the tie-break, a cycle broken by name. The **root** package is never a build target — its
`build` orchestrates workspaces rather than producing an entrypoint — and its value is recorded, not run.

**The execution.** In the worktree, under the **same constructed child environment** as the install, with the install's
own shape of recorded outcome (`historical_build_command`, `historical_build_command_basis`, `historical_build_outcome`,
`historical_build_exit_code`, `historical_build_duration_ms`, `historical_build_output_tail`,
`historical_build_packages`, `historical_build_started_at` / `_finished_at`). A **build failure is a pre-evaluation
environment failure of the same class as a failed install**: the workspace is `unusable` and the command exits `5`, with
a recorded reason, and no run, no `evaluations[]` entry and no ledger status. "Usable, but the gate will fail for an
unrecorded reason" is exactly the state this exists to destroy.

**The exposure, disclosed.** The install runs with `HUSKY=0` precisely so npm's only lifecycle script is neutralised. A
build **executes the historical commit's own `build` string with no equivalent neutraliser** — a strictly larger class
of script — so `historical_build_executed_arbitrary_scripts` is permanently `null` with a basis saying so, and never
`true`. Stated plainly, because it is easy to understate: a worktree is not a security boundary. That code ran with the
operator's privileges on the operator's filesystem, and nothing in this record observes what it did once it was running.
`--build-command` lets an operator supply the command explicitly; it is recorded as a **DECLARED** input (never silently
substituted), and the harness spawns an **argv**, never a shell string, so a shell metacharacter is refused rather than
interpreted. `--no-build` disables the step and records a deviation; supplying both is refused.

#### Build state — the observation, and exactly what it does not detect

`build_state` is an observation of the **source-tree** build outputs, which the installed-tree fingerprints cannot see
because they look only at `node_modules`:

| field                    | meaning                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build_state.observed`   | `false` means the state **could not be observed** — a failure to observe, never an absence of build output                                                                                             |
| `build_state.digest`     | a content-tier digest over the planned packages' declared build-output regions                                                                                                                         |
| `build_state.regions[]`  | per planned output: path, kind (`directories` / `files`), `present`, entry count, digest, `shape_matches`                                                                                              |
| `build_state.ignored`    | the **names** git reports as ignored for this worktree, via `git --no-optional-locks status --porcelain --ignored=traditional` with the worktree as cwd (measured: 50 ms, 25 lines on this repository) |
| `build_state.limitation` | what the observation detects and what it **cannot**                                                                                                                                                    |

The ignored-path half is what covers the whole class with **one** honest observation instead of a field per artefact: it
names `shared/dist/`, `server/dist/`, `ui/dist/`, `ui/.angular/` and `ui/public/themes/manifest.json` — all gitignored
build products that `status_hash` cannot see. It is **names only**. A gitignored **secrets** file such as
`server/.dev.vars` is named because git names it, and its contents are never opened, hashed, digested, printed or
recorded; only the declared build-output directories are ever read as bytes.

`build_state.limitation` states, in the record's own words, that this is an **observation of bytes, not a content pin**.
It **cannot** detect a build product outside the planned entrypoint directories, a build product the commit's own
`.gitignore` does not list, any change to the **build** that produced the bytes (two builds emitting identical bytes are
indistinguishable), or anything at all about the primary checkout.

#### Build state in the reuse key — and fail-closed on the unobservable

A workspace whose `shared/dist` was deleted or stale must not be certified **`reused — re-verified … all match`**, so
the build state is a **third leg of the same argument** as the metadata and the installed tree. Each refusal keeps its
own name, because "the build state changed" and "the build state cannot be observed" are different facts with different
consequences:

| refusal reason                           | meaning                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `historical_build_mode_mismatch`         | the attestation was built under a different mode (`derived` / `declared` / `disabled`) |
| `historical_build_plan_mismatch`         | the plan itself differs, so the two workspaces are not interchangeable                 |
| `build_state_changed`                    | the build outputs are present but are **not** the bytes the attestation recorded       |
| `build_state_unobservable`               | the state could not be observed at all — **fail closed**, no fallback                  |
| `build_state_unattested`                 | the attestation carries no build-state digest; "no digest" is **not** "no change"      |
| `build_state_recorded_for_an_empty_plan` | a plan that builds nothing must not carry a build-state digest                         |

A call site that supplies **no** build component is not refused — that would make the installed-tree half unreachable —
but the returned state says the build was **not** verified, so a caller that forgets to pass it cannot mistake the
result for a full verification. `workspace prepare` never takes that path.

#### Build state in the environment record

`evaluate` performs no build (`historical_build_mode: null`, `historical_build_outcome: "not_run"`, with a basis that
says so and names which step, if any, did build the workspace), but it **observes** the build state of the tree the gate
is about to run in and records it in `environment_observed` and in the ledger's `environments[]` under the same
conditional as `evaluations[]`. Without that a historical `evaluate` would carry a record that says nothing about the
build output its verdict depended on.

**Byte bound, not count bound.** `environments[]` is bounded by count (10 000) _and_ by **serialised bytes** against
`LEDGER_MAX_BYTES` (1 048 576), computed on the **writer** side. A count alone is not enough: 10 000 entries of 1–2 KB
are 10–20 MB, and a ledger over the limit is `rejected` on the next read and therefore permanently invisible to
`newestLedgerForTask`, `ledger show` and `report`. The writer evicts oldest-first and records the reason in
`bounded_reason`; a single record that does not fit the budget is **refused**, not written.

#### MANDATORY reading rule for `environments[]`

> An `environments[]` entry is a record of ONE invocation's observed local environment. It is **not a reproduction
> recipe** and it establishes neither reproducibility nor determinism, nor dependency authenticity, nor result
> authenticity. "Observed" means **this local program looked** — not that a lie would require a writer.
>
> A worktree is not a security boundary, and historical reproducibility is not result authenticity.

Two further limits, stated rather than implied:

- **It cannot retroactively exonerate or condemn any run recorded before it.** A ledger with no `environments` key reads
  as "not recorded" — a normal state, not an absence of evidence and not an accusation. Nothing in this record
  re-interprets a run that was already measured under the old contamination.
- **It does not pin the tree.** A correct `npm ci` under npm 12 is not the tree npm 9 would have produced (npm 12 blocks
  install scripts by policy), and no historical Node is installed. The tree is a function of
  `(lockfile bytes, npm version, node version, platform)` **on this host**.

**Scoping rule for the two commit-binding state-quality kinds.** `result_unbound` (the newest evaluation recorded no
observed judged commit) and `declared_not_judged` (the newest entry's own `declared_source_commit` does not match that
same entry's own `judged_commit` — an **entry-versus-entry** comparison, never against the ledger's frozen
`source_commit`) are computed ONLY from the newest `evaluations[]` entry, identified by its `run_id`. A run that
appended no entry — `--no-gate`, `gate_incompatible`, or a run with no attached ledger — triggers **neither** kind, so a
legal non-evidence run can never manufacture state. Both kinds are record-only: no status, no exit code, no enum, and no
classifier input.

**One thing this record does not detect, stated rather than implied:** `ledger.source_commit` is a frozen copy taken at
`ledger init`, and `evaluations[].declared_source_commit` is read at run time. A contract edited between the two is
**not** detected by any kind. Neither is the reverse: a judged commit that differs from the declared commit is not
evidence that the result is wrong — `source_commit` is a **diff base**, not a claim about what was executed.

The full gate output is kept beside the JSONL as `.harness/state/runs/<run_id>.gate.log` (ignored, not versioned).

## 2a. Two-commit comparison artifacts — `regress-<timestamp>.json` (optional, additive, non-causal)

`harness regress --good=<ref> --target=<ref> --task=<id>` compares **two named commits** and writes one artifact under
`.harness/state/reports/`. It is a **report artifact, not a ledger record**: `regress` attaches no ledger, appends no
`evaluations[]`, `environments[]` or `verification[]` entry, and sets no status, so it **enters no ledger-derived
denominator**. The file is read by no decision path. A two-commit comparison is not a task verdict and must never be
laundered into one.

**It is not invisible in `report` either, and that is stated rather than glossed.** Each side is an ordinary
gate-bearing `evaluate` run, so both are counted in `runs_total`, `terminal_evaluations`, `mechanically_verified` and
`verification_success_rate`. Every side carries a `run_origin` of `<regress_comparison>:<invocation_id>`, and `report`
publishes the count under **`comparison_sourced_runs`** (printed in the human summary, present in the JSON with the
exact run files it covers). **No existing denominator is changed** — excluding comparison runs would silently redefine
what `report` has always meant — so the claim is made true by _disclosure_, not by subtraction.

| Key                                          | Meaning                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                       | `harness_regress_comparison`                                                                                                                                                                                                                                                                                                                |
| `task_id`, `gate`                            | the contract both sides answered, and the resolved gate name (never invented)                                                                                                                                                                                                                                                               |
| `declared_source_commit`                     | the contract's **DECLARED** commit — a diff base, never a statement about what was executed                                                                                                                                                                                                                                                 |
| `requested`                                  | the `good` and `target` refs **as typed**                                                                                                                                                                                                                                                                                                   |
| `sides.good` / `.target`                     | each side's full record: `requested_ref`, `requested_commit`, **BOTH** observed commit samples (`observed_judged_commit` pre-gate and `observed_judged_commit_post` post-gate), `state`, `reason`, `run_id`, `status_hash_pre`/`status_hash_post`, gate result, `failing_step`, the workspace attestation fields and the environment record |
| `status_hash_scope`                          | what `status_hash_*` is and is not: a digest of `git status --porcelain`, NOT a tree identity, with the measured values and the commit-change blind spot spelled out                                                                                                                                                                        |
| `verdict` / `verdict_reason`                 | the pair decision, and the reason **including both observed commits**                                                                                                                                                                                                                                                                       |
| `verdict_basis` / `verdict_basis_text`       | always `single_observation` with the sentence explaining what one observation can and cannot decide                                                                                                                                                                                                                                         |
| `observations_per_side`                      | `1` — the number of observations the direction was derived from                                                                                                                                                                                                                                                                             |
| `withdrawal`                                 | non-null only when a contradicting confirmation **refused** the direction (§2a.2a): `from_verdict`, `first_observation_exit_code`, `second_observation_exit_code`, `replaced_by: cannot_compare`, `asserted_instead: null`                                                                                                                  |
| `verdict_disclosures`                        | disclosures that **qualify the verdict** — today the `gate_execution_differs` disclosure (§2a.2b)                                                                                                                                                                                                                                           |
| `comparison_exit_code`                       | the comparison's own code, before the exit-precedence rule                                                                                                                                                                                                                                                                                  |
| `exit_code`                                  | **the process exit** (§2a.3) — the printed `exit:` is always this value                                                                                                                                                                                                                                                                     |
| `exit_precedence`                            | the rule, whether a removal was refused, and whether the refusal raised the code                                                                                                                                                                                                                                                            |
| `invocation_id`, `gate_env_policy_requested` | this invocation's identity, and the gate-environment policy that was forwarded to both sides (`sides.*.gate_env_policy_observed` is what the gate actually got)                                                                                                                                                                             |
| `environment_comparison`                     | per-field good/target values, which differences are material, and any non-authoritative `disclosures[]`                                                                                                                                                                                                                                     |
| `confirm_disagreement`                       | the opt-in second observation, or `null`                                                                                                                                                                                                                                                                                                    |
| `cleanup`                                    | what was reclaimed, the bytes, and any **refused** removal                                                                                                                                                                                                                                                                                  |
| `limitations`                                | the standing limits, recorded with the result                                                                                                                                                                                                                                                                                               |

### 2a.1 The four side states, and their exact boundaries

| State          | Boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`         | the gate ran to completion, **every** step exited 0, and nothing below made the outcome undecidable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `FAIL`         | the gate ran to completion and at least one step exited non-zero                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `INCONCLUSIVE` | the side **was measured**, but the measurement cannot decide a verdict: a refused or unusable workspace preparation, a missing environment record, `status_hash_pre != status_hash_post` (the working tree moved while the gate ran), **`judged_commit_pre != judged_commit_post` (the COMMIT moved while the gate ran — invisible to `status_hash`, which is byte-identical across a commit change on a clean tree)**, a resolver probe that resolved a dependency **outside** the side's own workspace, an observed `judged_commit` that is either of the two samples but **not** the requested commit, a differing `contract_digest`, a differing resolved gate, or a mechanically attempted acceptance that came back `unresolved` |
| `ERROR`        | a harness/operational failure: a command could not be run to completion — an unresolvable ref, an unreadable run stream, or a `gate_incompatible` workspace, for which no gate result exists at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**`ERROR` is a statement about the TOOL** (something did not run), **while `INCONCLUSIVE` is a statement about the
EVALUATED STATE** (the tool ran, and what it saw is not decisive). That one sentence is the whole distinction.

**`INCONCLUSIVE != PASS` and `INCONCLUSIVE != FAIL`**, and this is enforced **structurally** rather than by convention:
the pair decision is a lookup over the two _decidable_ states only, so an undecidable side has no row to enter and there
is nothing to launder. The other side is never declared the winner.

**A side is identified by BOTH of its judged-commit samples, never by one.** `observed_judged_commit` is the pre-gate
sample and `observed_judged_commit_post` the post-gate one; both travel with the side, the printed line and the
artifact, and **any disagreement between them makes the side `INCONCLUSIVE` on that ground alone** — as does either of
them naming a commit other than the requested one. This is the load-bearing half of §2a's commit binding: a gate that
runs `git checkout` mid-step leaves a _clean_ worktree, so `status_hash` is byte-identical and a classifier that read
only the pre-gate sample would attribute the result to a commit the gate never ran against. Two samples are two samples,
not a proof — the bound here is that a side whose commit is not pinned by both of them decides **nothing**.

### 2a.2 The comparison rules, each with its printed reason

| good \ target      | `PASS`                         | `FAIL`                         | `INCONCLUSIVE`                 | `ERROR`                        |
| ------------------ | ------------------------------ | ------------------------------ | ------------------------------ | ------------------------------ |
| **`PASS`**         | `no_regression`                | `regression`                   | `cannot_compare`               | `ERROR`-coded `cannot_compare` |
| **`FAIL`**         | `improved`                     | `already_failing`              | `cannot_compare`               | `ERROR`-coded `cannot_compare` |
| **`INCONCLUSIVE`** | `cannot_compare`               | `cannot_compare`               | `cannot_compare`               | `ERROR`-coded `cannot_compare` |
| **`ERROR`**        | `ERROR`-coded `cannot_compare` | `ERROR`-coded `cannot_compare` | `ERROR`-coded `cannot_compare` | `ERROR`-coded `cannot_compare` |

- `no_regression` — both sides PASS. **`PASS` does not mean green**: "was green before and is still green" is not a
  quality claim.
- `regression` — the good side PASSES and the target side FAILS. The printed reason carries the **failing step** and
  **both observed commits**.
- `already_failing` — both sides FAIL. This is a **pre-existing failure**, stated in those words, and it is
  **deliberately not laundered into a regression finding**: the tool did not observe a break being introduced between
  these two commits, and saying so anyway would be a claim it has no evidence for.
- `improved` — the good side FAILS and the target side PASSES. Reported as an improvement rather than dressed up.
- `cannot_compare` — at least one side is `INCONCLUSIVE` or `ERROR`. The reason **names which side is undecidable and
  why**, and **no regression statement is printed in any form**.
- `--good` and `--target` naming the **same commit** (compared after resolution to 40-hex, so an alias cannot slip
  through) is refused before anything is created: verdict `not_a_comparison`, exit 2. Reporting a comparison there would
  dress one observation up as a difference between two.

### 2a.3 Command-local exit codes — never evaluate exit codes

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| `0`  | comparison completed; `no_regression`, `already_failing` or `improved`                                            |
| `1`  | comparison completed; `regression`                                                                                |
| `2`  | usage error, or refused (missing flags, unknown gate, same ref on both sides)                                     |
| `3`  | **never emitted.** It is evaluate's `gate_incompatible`, and a command that never runs a gate must not produce it |
| `4`  | a side is `ERROR` — the tool could not do its job                                                                 |
| `5`  | a side is `INCONCLUSIVE` — the pair cannot be compared                                                            |
| `6`  | a workspace removal was **refused** during cleanup                                                                |

**The exit precedence rule, and the printed exit is the process exit.** A **finding (`1`) outranks a refused cleanup**:
a finding is a statement about the code, a refused removal is a statement about a directory this process tried to
delete, and substituting the second for the first would let a permission problem silently demote a real regression. So a
refused cleanup **raises only a no-finding `0` to `6`**; in every other case the comparison's own code is **preserved**
and the refusal is **disclosed beside it** — it never replaces `4` or `5`, because an undecidable side is a statement
about the evaluated state and must not be hidden behind a directory. The rule is printed in every report and recorded in
every artifact, and **a reader can never see `exit: 5` while the shell returns 6**. None of these codes is ever
reinterpreted as, or allowed to collide with, the evaluate protocol (`0 ⟺ verified`, `1`, `2`, `3`).

### 2a.2a A confirmation may refuse a direction, never assert one

`--confirm-disagreement` is opt-in, non-authoritative, and runs under the **same environment policy the comparison ran
under** (read from that side's own environment record, never from the flag the operator typed — a re-run under a wider
environment is not a confirmation of anything). It re-runs the failing step **once** and records both observations.

- **Agreeing** observations leave the decision byte-identical. A deterministic predicate is unaffected.
- **Contradicting** observations **withdraw** the direction to `cannot_compare` (`exit 5`) with a printed reason, a
  `withdrawn:` line, and `withdrawal.asserted_instead: null`. The opposite direction is **never** substituted: the tool
  may refuse a direction, but it may not invent one.
- `flips_verdict` stays `false` and `asserts_direction` is `false` — a single re-run cannot distinguish a flaky
  predicate from a real difference, and that is a known limitation, not a fix.

**Every verdict is labelled `[single observation per side]`**, with `verdict_basis: single_observation`, because a
direction derived from one observation is an observation and not a proof.

### 2a.2b `gate_execution_digest` — what each side's gate actually ran

Each side digests the **resolved gate definition** this process will execute, together with **the judged commit's own
definitions of the scripts that gate invokes**, read from the manifests **inside the judged workspace** — never from the
contract, never from the primary checkout. A difference is a **prominent** disclosure: its own block inside the
comparison, above the routine environment table, plus `verdict_disclosures[]` in the artifact.

The shape it closes: a commit that replaces the gate's own `test` script with `node -e "process.exit(0)"` — deleting the
assertion that was failing — would otherwise be reported as `improved` while the application is still broken, and the
`lockfile_digest` is **byte-identical** across that pair, so nothing else in the record could see it.

**The residual limit:** a gate whose **behaviour** changes without its **script text** changing is still invisible to
this digest. It records _what_ each side ran, never _why_ it produced the exit code it did. Known limitation, not a
solved problem.

### 2a.4 MANDATORY reading rule for a comparison artifact

> A `regress` artifact records a comparison of two named commits made by one local program on one host. It is **not a
> task verdict**, establishes no reproducibility, no dependency authenticity and **no result authenticity**, and enters
> no **ledger-derived** denominator. Its two `evaluate` runs **do** appear in `report` and are disclosed there as
> `comparison_sourced_runs`. "Observed" means **this local program looked** — not that a lie would require a writer.
>
> A worktree is not a security boundary, and historical reproducibility is not result authenticity. A same-principal
> writer still controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger.
>
> The verdicts name **observed** commits, never the contract's declared `source_commit`.

**A single observation cannot distinguish a flaky acceptance predicate from a genuine difference** between two commits.
`--confirm-disagreement` re-runs the disagreeing side's failing step **once** and records **both** observations, and
that is a **known limitation, not a fix**: it is explicitly non-authoritative, it never **asserts** a direction, and it
can only ever **withdraw** one the comparison had already observed to be contradicted (§2a.2a). Two agreeing
observations are still two samples, not a proof. It is off by default.

**Environment differences are DISCLOSURES, never verdicts.** The two sides are _supposed_ to differ — that is what
comparing two commits means — so a differing `dependency_provisioning` or a missing/present `installed_state_digest` is
reported and explicitly marked `authoritative: false`. Converting a difference in the measurement apparatus into a
finding would manufacture a regression out of the instrument.

### 2a.5 Recorded NO-GO: automatic `git bisect`

`git bisect` is **not implemented** — no command, no flag, no stub, and nothing a future edit could wire up by accident.
Four independent reasons, each of which would be sufficient:

1. **The predicate is not monotone.** For a whole-project gate, a break is routinely _fixed later_, so "all descendants
   of a bad commit are bad" is false. Bisect assumes exactly that, and the conjunction of non-monotonicity with that
   assumption makes its answer unfalsifiable from the outside.
2. **git has no representation for a flaky predicate.** `0` = good, `1–127` = bad, `125` = untestable/skip. A gate that
   fails 1 run in 10 at the _same_ commit is, to git, ground truth.
3. **Mapping `INCONCLUSIVE` onto `125` is laundering.** `125` makes git _skip_ a commit and keep narrowing — so the
   undecidable commits are precisely the ones suppressed, and the commit that would explain the result is the one most
   likely to be skipped. `INCONCLUSIVE` must stay undecided, and skipping is a decision.
4. **No `pick_winner`.** There is no well-defined "winner" between two sides when one of them is undecidable, and any
   tie-break would be a preference for the side that looks better, which is precisely the defect this increment exists
   to remove.

**The falsifier — what evidence would overturn this NO-GO.** All three must hold, together:

1. A **flake study**: `0` verdict flips in `N` repeated runs of the same comparison at each of **at least 3 commits**
   (including at least one known-failing one), with a stated `N` and a stated run count. A single flip at any commit
   falsifies the flake half of the case for that predicate.
2. **Monotonicity evidence** on a long commit window — a **≥ 50-commit** window (or a per-step predicate with the same
   evidence), showing that a failure at commit `X` really is accompanied by failure at every descendant tested, or a
   documented, mechanical account of why not.
3. **A skip-suppresses-the-culprit mapping** that never reports a commit it cannot bracket: for every reported culprit,
   the interval that produced it is shown, and every `INCONCLUSIVE` commit inside that interval is enumerated rather
   than skipped. Any run whose interval contains an unexamined commit is not a report.

Absent all three, the NO-GO stands and the correct tool remains `regress`: it localises **nothing** and compares **two
named commits**.

#### 2a.6 The fifth reason: the `check` gate is UNDEFINED over 60.1 % of this history

Independent of the predicate, and independent of the reasons above: **the gate this repository's own history declares
does not exist over most of it.** Of the **143 commits of the range that ends at `bcf7b19`**, **86 (60.1 %)** declare
**no `ui` `typecheck` script at all**, so a whole-project `check` gate cannot be defined from their own manifests. The
block is **contiguous and older**: its boundary is **`81165e6`** (the oldest commit that _does_ declare the script) and
the run below it reaches the initial scaffolding commit `1e06f13`. Only **57 of 143** commits are in range.

> **Basis.** For each of the 143 commits, read `<commit>:ui/package.json` and test `scripts.typecheck` for a string. The
> 86 without it are `false` for every commit from `e5ece52` (the newest of them) to `1e06f13` (the oldest), with no
> interruption. `git log --format=%H -n 143 bcf7b19` supplies the window. Recomputed, never remembered.
>
> **The window is PINNED to `bcf7b19`, not to `HEAD`, on purpose.** The figure is a property of a fixed range of
> history, so the range is named by its tip: a commit landing on top of `bcf7b19` cannot change what those 143 commits
> contain. A sliding window over live history compared against a frozen constant is red on every commit that lands after
> the constant was measured — which is what happened here, and why the literal is 86 and not 85.

**Those 86 commits are UNDEFINED, not red** — and the difference is the whole thesis, so it is not left implicit: no
gate ran there, nothing failed, and nothing is attributed to those commits. A failure is a **measurement**, and there is
no measurement to report. A bisect here would face git's `125` (**untestable**) over most of its range, and git's answer
to a `125` is to **skip and keep narrowing** — dropping the commits whose undefinedness _is_ the missing evidence,
biasing the search late in a fixed direction, and reporting a boundary it never examined. That is the `INCONCLUSIVE` vs
`125` distinction of §2b "Repeated evaluation" arriving as a **property of the repository**, before any flakiness
question is asked.

### 2b. Repeated evaluation — `regress --repeat=N`, and why the rule is a contradiction and never a vote

> **Terminology, in one place.** A commit under comparison is a **candidate**. A comparison reports an **observed
> transition** between two named commits, and a **boundary** is a candidate at such a transition. **A transition is not
> a cause**: the harness measures what two commits did, and a difference between them is a fact about the pair, never a
> statement about which commit is responsible for anything. A commit is therefore never named as the responsible party —
> a candidate can be the boundary and still be innocent, which is precisely why `INCONCLUSIVE` is non-resolving rather
> than a verdict about either side. `I26` and `E24-08` assert that the forbidden word appears nowhere in the runtime or
> in any of these documents, and that this rule is stated as a rule, not implied by the absence of a word.

`--repeat=N` runs **N independent trials per side**. Each trial is a complete `workspace prepare` + `evaluate` through
the ordinary machinery, with its own instance label, its own run id, its own run origin and its own full provenance.
`N = 1` is the default and reproduces the pre-`--repeat` behaviour exactly: same verdicts, same exit codes, same
terminal output, and an artifact that keeps the version-2 `sides` shape and only adds fields.

#### 2b.1 Why the rule is a contradiction and not a vote

1. **The protocol has no slot for the answer.** `git bisect` can say good, bad, or `125` = untestable — and `125`
   _excludes_ the commit while the search continues, so the commit that would explain the instability is the one that is
   dropped. There is no representation for "ran to completion, the answer is not the same twice", so a biased answer is
   reported as an answer that is merely wrong.
2. **The effect is not small.** On a four-commit fixture (`A` deterministic PASS, `B` flaky at p ≈ 0.2, `C`
   deterministic PASS, `D` deterministic FAIL; truth = `C`), **40/40** independent real bisects produced a **wrong
   boundary 40/40 times**, bimodally: only ever `B` or `D`. The correct answer never appeared in the observed
   distribution, so no amount of care at the reporting step could have recovered it.
3. **Repetition is not a remedy; it can be an amplifier.** A commit that failed only the _first_ run of a session agreed
   **58/59** times in one block — an exact one-sided bound of **p ≤ 0.087 %**, fifty-seven times _tighter_ than the
   **4.95 %** the same N certifies from zero flips — and failed **9/9** in the condition a bisect step actually runs in,
   with a **byte-identical** workspace attestation. Observing a single flip made the number look _more_ certain.
4. **A vote cannot be repaired by repetition.** At a flip rate near 0.5 a majority vote is wrong **exactly 50 % of the
   time for every N**. The error is in the estimator, not in the sample size.

#### 2b.2 The classification rule, normatively

> **ANY disagreement among the trials makes the side `INCONCLUSIVE` (`classification_rule_id: "contradiction"`).**
>
> **A vote is NEVER taken** — not a majority, not a best-of, not the last trial, not the most common state.

The order of the rules, and why it is that order:

| #   | rule id                                | fires when                                                  | classification |
| --- | -------------------------------------- | ----------------------------------------------------------- | -------------- |
| 1   | `no_trials_performed`                  | no trial ran at all                                         | `ERROR`        |
| 2   | `trial_error_not_averaged_away`        | any trial is `ERROR` (a statement about the **tool**)       | `ERROR`        |
| 3   | `trial_inconclusive_not_averaged_away` | any trial is itself `INCONCLUSIVE` (about the **state**)    | `INCONCLUSIVE` |
| 4   | `contradiction`                        | at least one trial says `PASS` and at least one says `FAIL` | `INCONCLUSIVE` |
| 5   | `unanimous_observation`                | every trial says the same decidable thing                   | `PASS`/`FAIL`  |

Rules 2 and 3 come **first** so that a majority of `PASS`/`FAIL` trials can never average an `ERROR` or an undecidable
trial away: four agreeing trials and one that did not measure is a side this tool knows nothing about, not a side that
passed. `vote_used` is recorded as `false` on every aggregate, and `majority_not_taken` records what a majority _would_
have said so that the refusal is legible rather than invisible.

#### 2b.3 The bound: exact, conditional, and never a licence

For each side the artifact reports `N` (trials performed / requested), `k` (the observations that disagreed with the
rest) and the **exact one-sided binomial upper limit** on the per-trial flip probability `p`, at confidence 0.95:

- **`k = 0`** — the zero-flip identity `p <= 1 - alpha^(1/N)` with `alpha = 0.05`. This is the safe direction: it is the
  loosest limit any N can certify from zero disagreements, and it is also the Clopper–Pearson value at `k = 0`, so the
  two derivations agree where they meet instead of switching conventions silently. Justified one-sided 95 % limits from
  zero flips: **N = 20 → p ≤ 13.9 %** (indefensible as a target), **N = 29 → p ≤ 9.8 %**, **N = 59 → p ≤ 5.0 %**, **N =
  149 → p ≤ 2.0 %**, **N = 299 → p ≤ 1.0 %**.
- **`k >= 1`** — the **Clopper–Pearson EXACT one-sided upper limit** `p <= BetaInv(1 - alpha; k+1, N-k)`, computed here
  as the root of the binomial tail `P(X >= k | p) = alpha` — the closed-form tail, inverted by bisection to `2^-100`
  over a total bracket. The `k === n` case short-circuits before any recurrence: `P(X >= n | p) = p^n` exactly, one
  term, no cancellation. For every other `k` the tail is a **term recurrence that is SEEDED IN LOG SPACE at the first
  included term** — the k-th term is formed as
  `exp(lgamma(n+1) - lgamma(k+1) - lgamma(n-k+1) + k·log(p) + (n-k)·log1p(-p))` and the recurrence continues upward from
  there, accumulating the remaining terms. It is NOT seeded at `(1-p)^n` and walked up: that seed underflows to exactly
  0 for `n >= 180` at any p large enough for k to be near n, which makes the whole tail evaluate 0 for every such p,
  drives the bisection bracket to 1, and would publish a bound of **certainty** while labelling itself `exact: true`. A
  **subnormal** seed is the same defect one step earlier and quieter — around `~1e-318` it carries about three
  significant bits, and walking hundreds of steps up from it produces a tail wrong by more than `1e-9` while every
  intermediate value stays a finite, plausible-looking double. So the seed is **rescued**: the arithmetic path is kept
  bit-for-bit wherever `(1-p)^n` is a normal double, and the log-space seed is taken only when that seed is zero or
  subnormal. If even the log-space seed is below double precision the function returns `0`, which is the correct
  rounding rather than a fabricated term. It is exact: the interval is not widened, shrunk or replaced by a normal
  approximation, and `exact: true` with the formula and the equation it solves travel in the record — and that label is
  **derived by residual**, by re-evaluating the tail at the published value, so it cannot survive a degenerate evaluator
  that answers every interior point of the bracket with 0.

`bound.exchangeability` is the standing line, and it names what breaks it in the same breath:

> `exchangeability: assumed, unverified` — what breaks it: a **positively correlated defect** (a warm/cold cache, a
> session-scoped resource, a first-run-only failure) or machine load. Under positive correlation the N trials are not N
> independent draws, the binomial bound is not a bound on anything real, and repetition buys nothing.

**The anti-conservative warning.** `bound.anti_conservative` fires when the bound at `k >= 1` is _tighter_ than the
zero-flip bound for the same N (`bound.bound_at_zero_flips` is printed beside it, so the direction is visible). A single
flip that tightens the number is a measurement defect wearing the costume of certainty: read the histogram, not the
bound.

**The unattainable case.** `bound.unattainable_below_floor` fires when the bound is `>= 0.5`: at p ≈ 0.5 **no repetition
count attains any bound below 0.5**, and a majority vote there is wrong exactly half the time, so more trials is not a
remedy. `direction_attainable: false` records the same fact about the _direction_: a vote was available, it was refused,
and no bound can make a direction attainable here.

**Forbidden vocabulary.** The words "stable", "confirmed" and "reproducible" (and any equivalent) appear **nowhere** in
the aggregate output or the repeat record. They are the words that turn a number into a guarantee, and a guarantee is
not what is measured. `E20-06` asserts their absence as an absence.

#### 2b.3a Order-aware trial scheduling — `repeat.execution_order`

A schedule of **good-then-target in every block** makes a defect **positively correlated with execution order**
_consistent between_ the sides and noisy _within_ none, so the one rule this program may use cannot see it. The schedule
is therefore **interleaved**: the first position inside a trial block **alternates** between the sides.

| `repeat.execution_order`         | type                                      | meaning                                                                                             |
| -------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `scheme`                         | `'single_block' \| 'interleaved_rotated'` | `single_block` at `N = 1` (the pre-`--repeat` order), `interleaved_rotated` at `N > 1`              |
| `rotate_first_position`          | `boolean`                                 | `false` at `N = 1`: one trial has no second position to alternate into                              |
| `positions_per_trial`            | `2`                                       | the two positions in a block                                                                        |
| `schedule`                       | `string[][]`                              | the order each trial was measured in, e.g. `[['good','target'],['target','good'], …]`               |
| `position_by_trial.good/.target` | `number[]`                                | the position each side occupied per trial (`0` = ran first)                                         |
| `schedule_digest`                | `string`                                  | sha256 of the schedule, truncated, so two runs are comparable                                       |
| `legacy_order_replaced`          | `string \| null`                          | the design replaced, NAMED so "this is not it" is checkable rather than asserted; `null` at `N = 1` |
| `is_legacy_order`                | `false`                                   | the negative control                                                                                |
| `basis` / `residual`             | `string`                                  | what the interleaving does, and what it does **not** cover                                          |

The schedule is a **pure function of `N`**, so a resumed `--repeat-session` replays each completed trial under the
position it was measured in; the position also travels in the trial log as an additive `order` field beside `sides`.

**`N = 1` is the backwards-compatibility anchor, and it is a field rather than a promise.** `schedule` is the single
block `[['good','target']]`, `scheme` is `single_block`, `rotate_first_position` is `false`, and the order block is
printed only at `N > 1` (inside `=== repeated evaluation ===`, which was already `N > 1`-only). The verdict, the exit
code and the terminal output at `N = 1` are unchanged.

`repeat.position_conditional` groups each side's trials by the position that side occupied. It is a **disclosure and
never a classification input** (`classification_input: false`): a position-conditional split is a strict subset of the
within-side disagreement the contradiction rule already catches, so it would add a name and not coverage. It is reported
because "the states moved with the position" is the diagnostic the interleaving exists to make visible.

**`execution_order.residual` — what the interleaving does NOT cover.** It permutes **position**, not **time**. A defect
whose outcome is a function of something the rotation leaves invariant — the **trial index** (its parity), the absolute
order of gate executions across the session, a one-shot resource consumed once per session wherever it sits in a block —
remains consistent across **both** sides in every trial and **cannot** be distinguished from a real difference. A defect
perfectly aligned to the _old_ design ("good always first, target always second in every trial") **is** covered. Any
schedule is periodic, so a defect periodic with the schedule is aligned with it by construction; randomising the order
would break that alignment while making the artifact impossible to re-derive, and would still be a heuristic. The
residual is recorded, not engineered away.

### 2c. Per-step evaluation — `evaluate --step=<name>`, and the `UNDEFINED` rule

The gate is **fail-fast with a `break`**, so a gate run yields data only for the prefix that ran and **per-step history
is unrecoverable from the record**. `--step=<name>` runs **one named step of a gate, independently, with no fail-fast**,
through the **existing** loop, the existing `runStep`, the existing `verification_started` / `verification_finished`
pair and the existing provenance format. It adds **no second ledger, no second workspace implementation and no second
provenance format**; a per-step run does not update the attached ledger at all (`step_scope.ledger_effect`).

| `step_scope`                               | type                        | meaning                                                                       |
| ------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| `mode`                                     | `'single_step'`             | one named step, not the conjunction                                           |
| `gate` / `requested`                       | `string`                    | the gate and the step name as asked for                                       |
| `state`                                    | `'runnable' \| 'UNDEFINED'` | the two states; **neither is a failure**                                      |
| `reason` / `detail`                        | `string \| null`            | for `UNDEFINED`, why the commit's manifests do not declare the script         |
| `step_position` / `step_total`             | `number`                    | which step of the gate definition, and how many                               |
| `command`                                  | `string \| null`            | the command, or `null` when nothing was spawned                               |
| `package_path` / `script` / `script_value` | `string \| null`            | the manifest the applicability was checked against and the script it declares |
| `fail_fast`                                | `false`                     | the loop held ONE step, so there was nothing a fail-fast could have skipped   |
| `checked_in`                               | `string`                    | the workspace the applicability was checked in                                |

`step_scope` is **additive and normalised to explicit `null` on write** on every whole-gate run, in the `run_started`
`gate_compatibility` event, in `verification_started`/`verification_finished`, in `run_finished`, on
`sides.<role>.step_scope` in the comparison artifact, and on the workspace attestation (`step_scope` +
`whole_gate_compatibility`). Historical records without it read as "not recorded".

**`UNDEFINED` IS A DISTINCT OUTCOME AND IS NEVER A `FAIL`.** A step whose npm script the **judged commit's own
manifests** do not declare has no command to run; `npm run <script>` against such a workspace exits non-zero, and
reporting that as a step failure would manufacture a `FAIL` out of the absence of a declaration. So: nothing is spawned,
no `verification_*` event pair is emitted, `gate_exit_code` is an explicit **`null`** — never `0`, the one number that
silently reads as a pass — and a side measured that way is **`INCONCLUSIVE`** through the ordinary
`classifyRegressSide`, never `PASS`, never `FAIL` and never a direction. This is the same distinction as §2a5: commits
whose manifests never declared a script are **UNDEFINED, not red**.

An **unknown step name** is a different thing and is refused **by name** (`assertGateStepExists`) before any workspace
is prepared or any install is spent — answering it with the whole gate would be the opposite of what the flag asked for.
A **bare `--step`** is refused too, because `parseFlags` has no allowlist and an unknown flag is silently ignored:
without the check, a capability requested would be silently not granted.

**A per-step run derives no terminal state.** Exit `0` still means "this run mechanically verified the **gate**", so a
per-step run never returns `0` and `mechanically_verified` is `false` even when the step exits `0`. No new exit code was
minted and `classifyLedgerStatus`, the `verification[]` shape, the 15-key `evaluations[]` entry and the evaluate exit
protocol are all unchanged.

#### 2b.4 `INCONCLUSIVE` is NON-RESOLVING, never skippable, and is not git's `125`

| this harness                                                                         | `git bisect`                                                |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `INCONCLUSIVE` / `undecidable_by_contradiction`                                      | `125` ("skip")                                              |
| a **refusal** to decide                                                              | an **instruction** to exclude a commit and keep narrowing   |
| `skippable: false`, `resolves_boundary: false`                                       | narrows the search, and drops the commit from consideration |
| the comparison becomes `cannot_compare`; the other side is never declared the winner | the search continues past the dropped commit                |

Inheriting git's meaning would bias a boundary search **late and in a fixed direction** rather than at random, which is
the failure this increment exists to remove. The two cases are named differently on purpose, in the output
(`git_skip_125_equivalent: false`, `skippable: false`, `resolves_boundary: false`) and in the docs.

#### 2b.5 Records, durability and non-causality

The artifact (schema version 3, additive) carries:

| field                           | what it is                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `repeat`                        | requested / default / max trials, the rule, `vote_used: false`, the per-side aggregates, the limitations                                       |
| `repeat.per_side.{good,target}` | the **aggregate**: classification, rule id, state counts, `k`, the bound record, `majority_not_taken`, `resolves_boundary`                     |
| `trials.{good,target}`          | the reduced per-trial observation: index, state, reason, run id, instance, commits, gate exit, tree hashes                                     |
| `trials_full.{good,target}`     | the complete side object of every trial, including its environment record                                                                      |
| `trial_provenance`              | per trial: `measured_by_this_invocation` or `replayed_from_trial_log`                                                                          |
| `trials_log`                    | the trial-log path, session, entry counts, the digest-chain verdict, and `append_only` / `rewritten`                                           |
| `trials_log.chain`              | the chained-digest verdict: `verified`, `entries`, `verified_entries`, `head_digest`, `head_agrees`, `break_reason`, `duplicate_trial_indices` |
| `trials_log.session_binding`    | the pair/task/gate/env-policy the session measured, and the `binding_digest` that decides a replay                                             |

The observation and the aggregate are **separate structures**: an observation is never overwritten by a summary, and a
reader can rebuild the full distribution from the artifact without re-running anything. Every new field is normalised to
an explicit `null` on write, and a ledger written before any of this keeps loading and reads as "not recorded" — the
ledger has no repeat fields at all.

#### 2b.6 The trial log is a CHAIN, and a replayed trial is RE-DERIVED

Three refusals guard the replay path. Each is **named** in the output, each fires before any workspace exists, and none
of them is a security control. The operator view is in [the manual](../README.md#L702).

| refusal name                      | what it means                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `REPLAY_SESSION_BINDING_MISMATCH` | the `--repeat-session` token measured a **different** pair, task, gate or environment policy; every differing field is listed by name |
| `TRIAL_LOG_CHAIN_BROKEN`          | the digest chain or its head does not verify — an interior rewrite, a removed row, a reordered row, or a tail truncation              |
| `DUPLICATE_TRIAL_INDEX`           | one trial index is recorded **twice under different invocations**, i.e. two concurrent runs shared one token                          |

**The session binding.** A token names one comparison. `binding_digest` is a sha256 over `task_id`, `gate`,
`requested.{good,target}`, `resolved.{good,target}` and `gate_env_policy`; replaying a token against a different pair is
refused rather than answered with the wrong measurements. An **absent** binding is a refusal too, not a pass: a log that
records no binding has established nothing about what it measured.

**Re-derivation (the important one).** A replayed trial's recorded `state` is **not believed**. The recorded
`gate_exit_code` and `judged_commit` are re-read from the run stream the trial names, the state is re-derived from those
two facts, and any disagreement marks the trial `verified: false` with a named reason (`run_stream_not_found`,
`run_stream_has_no_run_finished`, `gate_exit_code_disagrees_with_run_stream`, `judged_commit_disagrees_with_run_stream`,
`state_disagrees_with_run_stream`). An unverified trial is a boundary of its own — `classifiable: false`, rule
`trial_unverified_not_averaged_away` — so **agreeing sibling trials never average it away** and the side can never
produce a direction.

**The chain.** Every entry commits to the **previous** entry's digest, so an interior rewrite, removal or reordering
breaks it, and a separate `.head.json` records the entry count and last digest, which is the only thing that can see a
**tail** truncation (a chain over the retained rows cannot). `append_only: true` and `rewritten: false` describe **this
program's own writes** and are backed by that mechanism.

> **What the chain is not.** It is a truncation-or-rewrite **detector for this program**, which is a smaller claim than
> authenticity. It does not make the log tamper-proof, it cannot see a same-principal writer who rewrites the log and
> the head together, and it authenticates nothing. A same-principal writer controls the log, the head file and this
> program, just as it controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the
> ledger. What changed is narrower and is the only thing that was actually wrong: the harness no longer **asserts**
> properties it has not checked.

**Two limits, named apart.** `REPEAT_MAX_TRIALS` (299) is a **count** of trials per side. The **size** limit is a
separate, enforced bound, `REPEAT_TRIALS_LOG_MAX_BYTES` (8 MiB), checked by `appendRegressTrialEntry` **before** every
append: exceeding it refuses the append with `TRIAL_LOG_BYTE_BOUND_EXCEEDED` and writes nothing. Neither is a retention
policy — the log is not rotated.

**Concurrency is detected, not locked.** Two concurrent `--repeat` runs on one token both write; the second breaks the
chain and duplicates a trial index, and the collision is refused by name. An `O_EXCL` per-session lock was built,
measured against a real SIGKILL-then-resume, and **removed**: `kill -9` never releases it and `process.kill(pid, 0)`
succeeds against a **zombie**, so the lock refused the very resume it existed to protect. A lock trades silent
corruption for a wedge, and a wedge on the resume path defeats the purpose of the resume path.

**The cross-trial environment comparison is over ALL trials** (`environment_comparison_across_trials`,
`scope: "all_trials"`), not trial 0 alone; the trial-0 block carries `trial_0_only: true` so it can never stand
unqualified. A **material** field that varies **within** one side is a contradiction
(`pair_input_disagrees_across_trials`) and makes both sides `INCONCLUSIVE` rather than producing a direction between two
different environments. A non-material field that varies stays a disclosure.

**Interrupted worktrees are reachable.** `workspace prepare` writes a `preparing` attestation **before** the install is
spawned, and `workspace prune` walks the workspace root's `<key>/<instance>` layout comparing **names** against the
attestation set, so a worktree whose prepare was interrupted is reclaimable by the shipped path. The reclaim report
distinguishes "nothing to reclaim" from "orphans exist" — it opens no file inside an orphan. **`--out` into a reserved
state directory** (`state/runs`, `state/control`, `state/tasks`, `state/ledgers`, `state/regress-trials`) is **refused
by name** and is never silently redirected to the default `reports/` path.

Each completed trial is **fsynced to `.harness/state/regress-trials/regress-trials-<session>.jsonl` as it completes**,
so an interrupted run loses nothing it had already measured; `--repeat-session=<token>` replays the completed trials
instead of re-running them, and never rewrites them. `N` is bounded at `REPEAT_MAX_TRIALS = 299`, which is the byte
bound on that log.

`regress` remains **NON-CAUSAL with respect to LEDGER terminal state at `N > 1` exactly as at `N = 1`**: no ledger is
attached, no `evaluations[]` / `environments[]` / `verification[]` entry is appended, and no status is set. Each _trial_
is an ordinary gate-bearing `evaluate` run, so `report` counts `2 x N` of them and discloses them under
`comparison_sourced_runs`; every existing denominator is unchanged.

#### 2b.6 What repetition does NOT fix

**A single observation cannot distinguish a flaky predicate from a real difference between two commits, and repetition
does not fix that.** More draws of the same predicate sharpen the estimate under an assumption the estimate itself
cannot check. `AGENTS.md` §"Two-commit comparison" and `.harness/README.md` restate this where an operator reads it.

The unchanged standing limitations apply verbatim: **a worktree is not a security boundary; historical reproducibility
is not result authenticity; a same-principal writer controls the gate, the contract, the acceptance policy, the
dependencies, the evaluator and the ledger.**

`git bisect` remains the recorded NO-GO of §2a.5 — un-implemented, with no flag, no stub and no code path — and repeated
evaluation does not reopen it: it makes a _comparison_ stronger, and it deliberately refuses to turn an undecidable
comparison into a boundary.

#### 2b.7 The `exact` label is CHECKED, and `anti_conservative` is arithmetic

**`exact` is derived, not asserted.** Every Clopper–Pearson record carries `exact`, `exactness_basis` and
`tail_residual_at_bound`. The evaluator re-evaluates the binomial tail **at the published value** and compares it with
`alpha`; the label is `true` only when that residual is within this program's own `1e-9` tolerance **and** no degenerate
evaluation was observed anywhere along the bisection bracket. `exact: false` always ships a reason prefixed
`NOT EXACT:`, and a value it cannot corroborate is published as `null` rather than as a number.

This exists because of a measured defect. The previous evaluator seeded the term recurrence at `(1 - p)^n` and walked it
up to the k-th term. For `n >= 180` at any `p` large enough for `k` to be near `n` that seed **underflows to exactly
0**, so the whole tail evaluated 0 for every such `p`, the bisection saw "tail below alpha" everywhere and drove `low`
to 1: `regressFlipRateUpperBound(179, 180)` returned **`value: 1`** — a bound of certainty — while labelling itself
`exact: true` and printing an equation it did not solve. 143 reachable `(k, n)` pairs were affected. The correct
Clopper–Pearson upper limit there is **0.973917696671**. The error was conservative and verdict-neutral, and it was
still the one class of wrong this harness exists to refuse: a record asserting `exact: true` about a computation that
did not happen.

The evaluation is now seeded in log space, and it switches to that seed whenever the direct one is not a **normal**
double. The subnormal case is the same defect one step earlier and quieter: at `n = 196, p ~ 0.976` the seed is
~`1e-318`, eleven orders of magnitude below the smallest normal, carrying about three significant bits. Walking 195
steps up from it produced a tail wrong by more than `1e-9` while every intermediate value stayed a finite,
plausible-looking double. That was found by an **independent exact-rational reference** — every finite double in
`[0, 1]` is a dyadic rational `m / 2^s`, so `sum_{i>=k} C(n,i) p^i (1-p)^(n-i)` is exactly computable with `BigInt` at
the published value, with no logs, no doubles, no recurrence and no code shared with the implementation. The self-test
sweeps `n = 180 … 299` at `k = n-1`, `k = n`, `k = 1` and `k = floor(n/3)` — 480 pairs — and requires every published
bound to solve its printed equation to better than `1e-9` in exact rational arithmetic.

**`anti_conservative` is an arithmetic property, not a measurement.** The flag fires when the exact limit at `k` is
tighter than the zero-flip bound for the same `N`. At `k = 1` the exact limit is already about `0.05 / N`, so
**essentially every ordinary disagreement fires it, including a perfectly exchangeable `p = 0.01` observation.** The
record therefore carries `anti_conservative_is_evidence_of_defect: false` and
`anti_conservative_evidence_of_defect_basis`, and the warning states plainly that the flag is the arithmetic of `k >= 1`
and is **not by itself evidence of a defect**. The earlier wording called it "the visible signature of a defect that is
NOT exchangeable", which an ordinary exchangeable observation produces too.

The **measured** evidence for a non-exchangeable defect is a different, named thing and is unchanged: a commit that
failed only the first run of a session agreed **58/59** times in one block, then failed **9/9** in the condition a
boundary-search step actually runs in, with a **byte-identical** workspace attestation. That warning keeps firing, and
it keeps carrying all three facts.

#### 2b.8 Historical workspaces: the unattested population has a SIZE, and escape is OBSERVED

Two new additive groups, both on the workspace attestation and both normalised to explicit `null` on write.

**The pre-exclusion entry count.** `installed_tree_fingerprint_entries` is POST-exclusion, so "every byte under those
paths is UNATTESTED" carried no magnitude. It now travels beside two more:

| field                                                 | what it is                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `installed_tree_fingerprint_entries`                  | post-exclusion entry count, as before                                                     |
| `installed_tree_fingerprint_entries_raw`              | the count BEFORE the exclusion removed anything                                           |
| `installed_tree_fingerprint_excluded_entries`         | how many entries the exclusion removed — the unattested population, as a number           |
| `installed_tree_fingerprint_excluded_entries_bounded` | `true` when the count was capped, so a bounded count is never presented as a complete one |

The reconciliation is exact and checkable: `entries_raw - entries === excluded_entries`. The count is a **count-only**
walk: directory names are listed, no file is opened, no byte is hashed. Quantifying what the exclusion leaves unattested
must not turn into an observation of the bytes the exclusion declines to attest. A count of `0` in a fresh workspace is
a correct reading, not a missing one.

**`exclusions_version` is part of the reuse key.** The exclusion set changes what the digest _means_ while leaving its
algorithm, its tier and its cost identical, so a workspace verified under one exclusion set is verified under different
rules. `computeWorkspaceKey` digests `installed_tree_fingerprint_exclusions_version` beside
`installed_tree_fingerprint_tier`, on the tier's own rationale: a version recorded in the attestation and nowhere in the
key is recorded but not enforced.

**The build's escape, and the class this program does not observe.** A build executes the judged commit's own `build`
string with the **operator's** privileges on the **operator's** filesystem, so its writes are not confined to the
worktree. `historical_build_outside_worktree_writes` therefore carries a bounded pre/post observation of three named
roots — the worktree's parent directory, the system temp directory and the home directory — compared by the digest of
their top-level **name** sets, with the added and removed names printed bounded and the paths themselves DIGESTED rather
than printed.

And, as **data in the same record** rather than as prose:

- `outside_worktree_write_detected` — a name appeared or disappeared in a probed root. `false` means "no top-level name
  changed in the three probed roots", **never** "the build wrote nothing outside the worktree".
- `outside_worktree_writes_fully_observed` — permanently `false`.
- `unobserved_class` — a write INSIDE a directory that already existed is not detected (its name set does not change); a
  change to a file's contents is not detected (only names are compared); any write to the unbounded remainder of the
  filesystem is not detected at all.
- `prevention` — **`none`**. A worktree is not a security boundary, and this is a **detection and observability limit,
  not prevention**: the build ran with the operator's privileges, nothing here confined it, and every byte in the
  unobserved class is unattested. The standing limitation is unchanged and un-softened.

The observation is **disclosive only**: it decides no verdict, no exit code and no workspace state, and a disabled build
records `observable: "not_applicable"` rather than an empty sweep.

#### 2b.9 The build plan: a bare relative `main` is a path, and an undetermined plan is REFUSED

Condition (2) of the selection rule — "declares at least one relative entrypoint" — is read in **Node's own** terms, and
the two field families are different.

`main`, `types` and `typings` go through `legacyMainResolve`, which is `path.resolve(packageDirectory, value)`. A
**non-absolute** value there is therefore a path **relative to the package directory**, and `"main": "dist/index.js"`
resolves to `<package>/dist/index.js` exactly as `"main": "./dist/index.js"` does. `exports` is not the same: its keys
are subpath names that must begin with `./`, and its targets must begin with `./` or `../`, so a bare `dist/index.js`
there is a key that can never match and is not a path. Wildcards, `node:` specifiers and bare `.` / `..` references are
not paths in either family.

**Why the rule reads values in Node's terms.** A rule that requires a `./` prefix produces **no entrypoint at all** for
`"main": "dist/index.js"`: the package is skipped with "no relative entrypoint declared", `build_state` is recorded as
**"not applicable (no build output is required by this gate)"** — and the gate then fails on a missing
`shared/dist/index.js`, which `regress` would score as a `regression` / `test_failure` **attributed to the commit**. A
narrower manifest spelling would recreate, through the plan, the exact **constant-red** defect the build step exists to
remove. `BUILD_PLAN_RULE_VERSION` is therefore **2**, and a rule change reclaims every workspace rather than silently
reusing one verified under the old rule.

**The residual is a refusal, not a guess.** A plan rule that a manifest spelling can defeat is not a fix, so when a
considered package declares a `main` / `types` / `typings` value the program cannot read as a path at all, the plan
records it under `build_plan_undetermined` (with `build_plan_undetermined_basis`) and `workspace prepare` **refuses**
with `BUILD_PLAN_UNDETERMINED` and **exit 2** — before a key is computed, and before any worktree, install or
attestation exists. The message prints the offending value, states that an undetermined plan is **NOT recorded as "no
build output is required by this gate"**, because that sentence is a claim the gate can contradict on its very next
step, and names the escape hatch: `--build-command=<argv>` declares the build yourself and bypasses the derived plan
entirely.

`build_state_basis` makes the same distinction from the other side. A null build state while the derived plan **did**
declare a package to build reads "not observed: the plan derived from this commit declares build output the gate
resolves through, and no build state was observed for it. This is NOT a claim that the gate needs no build output" — the
"no build output is required" sentence appears only when the plan is genuinely empty.

### Derived result semantics

```
mechanically_verified = gate ran AND every gate step exited 0
agent_claimed_done    = a claim was supplied to the evaluator (--claim / --claim-done)
false_done            = agent_claimed_done AND NOT mechanically_verified
acceptance_verified   = the acceptance verdict is exactly "pass"  (mechanism ∈ mechanical | human;
                        the default verdict is "unknown", so this is false unless a pass was recorded)
task_success          = mechanically_verified AND acceptance != fail
```

`task_success` is **provisional** while `acceptance_verdict=unknown`: it means "the mechanical gate passed", which is
weaker than "the task is done". This distinction is deliberate — see [`README.md`](../README.md) §"Reaching a contract
at all", which records a seeded `acceptance` as a SEED nobody wrote.

`self_test` marks a **mechanics check** (a run that exercises the pipeline rather than measuring an agent, e.g. a gate
re-run at the current HEAD). Such runs are recorded normally — they are evidence that the pipeline works — but
`harness.mjs report` **excludes them from every aggregate** and reports their count as `self_test_runs_excluded`, so a
committed `baseline.json` can never be mistaken for measured agent performance.

### Deliberately absent fields

`input_tokens`, `output_tokens`, `cached_tokens`, `cost`, `turns`, `tool_calls`, `cache_hit_ratio` are recorded **only**
when supplied on the command line, flagged
`"source": "manual (supplied on the command line; not observed by this script)"`. The evaluator never estimates, derives
or fabricates them.

## 2b. History census artifacts — `census-<timestamp>.json` (optional, additive, non-causal)

`harness census --from=<ref> --to=<ref> --step=<name> --task=<id>` measures a RANGE. It is a new QUESTION, not a new
implementation: every commit in the range goes through the ordinary `workspace prepare` and the ordinary
`evaluate --step` path, so a matrix row carries exactly the provenance a comparison side carries today. There is no
census ledger, no second workspace implementation and no second provenance format; the per-commit durable row is the
existing append-only trial log (`regress-trials-<session>.jsonl`, one chain, one head, one reader), which is why
`--census-session=<token>` resumes an interrupted census the same way `--repeat-session` resumes a comparison.

A census is **non-causal**: it attaches no ledger, appends no `verification[]`, `evaluations[]` or `environments[]`
entry, and sets no status. Its per-commit `evaluate` runs are ordinary gate-bearing runs, so `report` counts them and
discloses them under `comparison_sourced_runs` without changing any existing denominator. A historical artifact or
ledger without these fields reads as "not recorded".

### The five states

`matrix[].state` is exactly one of:

| state          | meaning                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`         | the step ran to completion and exited 0                                                                                                                   |
| `FAIL`         | the step ran to completion and exited non-zero                                                                                                            |
| `UNDEFINED`    | the JUDGED commit's own manifests declare no such script: **nothing was spawned**, `gate_exit_code` is an explicit `null`, and this is **never** a `FAIL` |
| `INCONCLUSIVE` | the commit was measured but the measurement cannot decide (a refused workspace, a moved tree, a changed `script_value`, undecidable rules)                |
| `ERROR`        | a harness/operational failure: this program could not run that commit to completion                                                                       |

`UNDEFINED` and `INCONCLUSIVE` are both **enumerated and non-resolving**. Neither is skipped, neither is a `FAIL`, and
no transition is ever read _across_ one. This is named differently from git's `125` on purpose: git's `125` means
"exclude this commit and keep searching", which biases a search **late in a fixed direction**. Here nothing is excluded
and nothing keeps searching.

### The outputs

| field                                                                                                                      | shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | meaning                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range`                                                                                                                    | `{from_ref, to_ref, from_commit, to_commit, commits, enumeration}`                                                                                                                                                                                                                                                                                                                                                                                                                        | the range the artifact is about; `enumeration` is `git rev-list --reverse --first-parent --ancestry-path from..to` with `from` prepended. **No narrowing, no sampling, no bisection.** |
| `matrix`                                                                                                                   | `[{index, commit, state, reason, run_id, observed_judged_commit, observed_judged_commit_post, gate_exit_code, step_scope, workspace_key, workspace_instance, workspace_state, lockfile_digest, installed_state_digest, installed_tree_fingerprint, installed_tree_fingerprint_tier, build_mode, build_outcome, build_state_digest, gate_execution_digest, status_hash_pre, status_hash_post, environment_record, harness_error, workspace_refused, step_requested, signature, replayed}]` | one row per commit of the range, every field explicit `null` when it does not apply                                                                                                    |
| `failure_regions`                                                                                                          | `[{start_index, end_index, start_commit, end_commit, length, commit_span, holes, interrupted_by_hole, contiguous_fail_run, basis}]`                                                                                                                                                                                                                                                                                                                                                       | each **run of observed FAIL commits**, with 40-hex endpoints. A hole does **not** split a run: see below                                                                               |
| `observed_transitions`                                                                                                     | `[{index, kind, direction, step, gate, from_commit, to_commit, transition_commit, from_state, to_state, is_reversal, evidence, terminology}]`                                                                                                                                                                                                                                                                                                                                             | every **adjacent** `PASS→FAIL` and `FAIL→PASS`. `transition_commit` is always the LATER row, in both directions                                                                        |
| `reversals`                                                                                                                | the `FAIL→PASS` subset of the above                                                                                                                                                                                                                                                                                                                                                                                                                                                       | a reversal means the predicate healed, so the history is not a step function of the commit                                                                                             |
| `candidates`                                                                                                               | `[{region, candidate, candidate_basis, candidate_reason, boundary_observed, preceding_observed_state, preceding_commit, region_start, region_end, region_length, region_commit_span, region_interrupted_by_hole, terminology}]`                                                                                                                                                                                                                                                           | the commit at each region's **observed** `PASS→FAIL` boundary, named **`candidate`**. `null` unless one was observed                                                                   |
| `replay_fidelity`                                                                                                          | `{persisted_derivation_inputs, not_persisted, basis, rows_replayed, rows_measured_now, degraded_derivation_inputs}`                                                                                                                                                                                                                                                                                                                                                                       | what a resumed census can and cannot carry back; `degraded_derivation_inputs` **must be empty**                                                                                        |
| `monotonicity`                                                                                                             | `{step, gate, scope, from_commit, to_commit, commits_measured, verdict, has_reversal, failure_regions, undecided_commits, errored_commits, counts, carries_no_information, …}`                                                                                                                                                                                                                                                                                                            | `MONOTONE` \| `NOT_MONOTONE` \| `UNDETERMINED`                                                                                                                                         |
| `refusal`                                                                                                                  | `{refused, single_boundary_identified, reason, not_offered, not_a_search, terminology, what_is_instead}` or `null`                                                                                                                                                                                                                                                                                                                                                                        | present whenever the range is non-monotone                                                                                                                                             |
| `unresolved`                                                                                                               | `{undefined_commits, inconclusive_commits, transitions_bridged_a_gap, non_resolving, basis, transitions_spanning_a_gap}`                                                                                                                                                                                                                                                                                                                                                                  | the enumerated holes                                                                                                                                                                   |
| `cascade`                                                                                                                  | `{rules, classifications}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the five rules, and each transition's full classification                                                                                                                              |
| `error_modes`                                                                                                              | `{CONFOUNDED_CONFIG_AND_SOURCE, MIXED_TEST_AND_SOURCE_COMMIT, TEST_EDIT_MAY_MASK_A_REGRESSION, PRODUCER_PACKAGE_UNRESOLVED, SIGNATURE_UNAVAILABLE, DIFF_UNAVAILABLE}`                                                                                                                                                                                                                                                                                                                     | the cascade's own limits, as DATA                                                                                                                                                      |
| `census_trials_log`                                                                                                        | `{path, entries_on_disk, entries_verified, chain, write_version, byte_bound}`                                                                                                                                                                                                                                                                                                                                                                                                             | the durable log and its verified chain                                                                                                                                                 |
| `not_causal`, `not_a_search`, `scope`, `terminology`, `is_a_search`, `limitations`, `exit_code`, `exit_rule`, `exit_basis` | strings / booleans                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the standing statements, always present                                                                                                                                                |

### Monotonicity — `MONOTONE` \| `NOT_MONOTONE` \| `UNDETERMINED`, scoped to `measured_range_only`

Decided in this order, and only in this order:

1. any observed reversal → **`NOT_MONOTONE`**
2. otherwise, more than one region **separated only by holes** → **`UNDETERMINED`** (a self-contradiction, not a finding
   — see below)
3. otherwise, more than one disjoint region → **`NOT_MONOTONE`**
4. otherwise, any `UNDEFINED` / `INCONCLUSIVE` / `ERROR` commit → **`UNDETERMINED`**
5. otherwise → **`MONOTONE`**

Step 1 precedes step 4 deliberately: a reversal was **observed inside the range**, and a hole elsewhere does not
un-observe it. `MONOTONE` is **structurally unreachable** while `has_reversal` is true — there is no branch that reaches
it. The verdict applies to **`measured_range_only`**: one range, one step, one environment policy, one machine. A range
can be `MONOTONE` here and non-monotone one commit earlier.

Step 2 is a **structural guard**, unreachable while `censusRegions` does not close a run on a hole, and asserted as
such. It exists because the failure it guards against is a **false dirty verdict**: a range whose regions are separated
by nothing but undecided commits has not healed anywhere, and printing `NOT_MONOTONE` over it would claim that it had.
`regions_separated_only_by_holes` and `holes_inside_regions` are on the record, and `a_hole_never_splits_a_region: true`
is asserted by the self-test.

#### A hole is a hole IN a run, not a boundary between runs

`censusRegions` closes a region on a **decided** non-`FAIL` row only. An `UNDEFINED` / `INCONCLUSIVE` / `ERROR` commit
observes nothing, so it can neither continue a run of observed failures nor break one: it is recorded **on** the region
as `holes`, with `interrupted_by_hole`, and `commit_span` > `length` by exactly the number of holes.

Closing a region on any non-`FAIL` row would split one unbroken defect cut by a hole into two independent regions, and a
**false dirty verdict** is worse than a false clean one: it invites a reader to hunt a second regression that does not
exist. Such a range is **one** region, `UNDETERMINED`, and therefore **exit 5**, which is what makes the `UNDETERMINED`
code reachable through the region path at all.

`carries_no_information: true` is a separate, honest disclosure: a step that `PASSES` at every commit is `MONOTONE` in
the trivial sense that a constant series is monotone, and it localises **no** boundary. A `MONOTONE` verdict on an
all-`PASS` step is not a clean bill of health for the step.

### The classification cascade — five rules, ALL asked, none short-circuited

1. `TEST_EVOLUTION` — the diff touches only files matching the **step's own** test glob
2. `CROSS_PACKAGE_MIGRATION` — the commit touches a **producer package the step does not own** AND the error signature
   names a changed export of it
3. `CROSS_PACKAGE_COMPLETED` — the commit touches a **foreign package**, an export of **that** package is named by the
   failing signature, and the name is **gone** from the signature afterwards
4. `PREDICATE_DESIGN` (`BUILD_STATE` \| `CONFIGURATION` \| `GENERATED_PATH`) — a changed file reads a generated path,
   the step's own resolved `script_value` changed, or the attested `build_state` moved
5. `SOURCE_CHANGE` — the residual

**Exclusivity is a property of a rule AND of the diff in front of it, not of a rule's number.** A single sentence
covering "rules 1 and 3" would be **false for rule 3**:

- **EXCLUSIVE, unconditionally — rule 1 only.** A diff that touched nothing but the step's own tests did not also change
  the source, so there is nothing to choose between and the label is emitted.
- **EXCLUSIVE, conditionally — rule 3.** It suppresses the residual **only** when `foreign_paths_only` is true, i.e. the
  diff touched nothing but foreign packages. When the same diff also changed files inside the step's own package, rule 3
  is **COMPETING** and `SOURCE_CHANGE` fires beside it. The record carries
  `subrules.CROSS_PACKAGE_COMPLETED.exclusivity` naming which of the two applied, and `foreign_paths_only` is the
  mechanical fact behind it.
- **COMPETING, unconditionally — rules 2 and 4.** Each _adds_ to a plain source change rather than replacing it, so both
  fire and the classification is `INCONCLUSIVE`.

**The trap rule 3 must not walk into.** A test for the **exact negation** of being cross-package
(`foreignPaths.length === 0`) plus "a signature name disappeared" is unsound: at a `FAIL→PASS` transition the after-tail
is a success message with no error lines, so `gone` is non-empty whenever the failing run printed any identifier. A
**docs-only** change, a **rename**, a **comment-line** change and a **one-file in-package source fix** each satisfy it —
so it fires at essentially every `typecheck` reversal, and, because it also set `exclusive_rule_fired`, it **suppressed
the SOURCE_CHANGE residual** and swallowed the one rule that would have marked those diffs as plain source changes. The
result is a **confident wrong label**, not an `INCONCLUSIVE`.

`subrule` is a **trigger name, never a classification**. `GENERATED_PATH` is reachable as a `subrule` and is asserted to
be, but it can never _be_ the reported classification: `PREDICATE_DESIGN` is `COMPETING` and never suppresses the
residual, so a generated-path trigger always fires beside `SOURCE_CHANGE` and the classification is always
`INCONCLUSIVE`. The record says so on the classification itself, in
`subrules.PREDICATE_DESIGN.classification_always_inconclusive`.

`INCONCLUSIVE` is the result when **more than one rule fires**, when **a rule could not be asked** (its evidence is
unreadable — recorded in `undecidable`, distinct from `inapplicable`, which means the rule was never in scope), or when
the diff itself could not be read. There is **no precedence among the rules and no way to ask for one**: `rule` is
`null` on a multi-firing. An undecidable rule never silently not-fires.

A classification describes the **shape of the diff at an observed transition**, read mechanically. **It is not a cause,
it does not apportion a commit**, and it does not establish that the named mechanism is what moved the verdict.

### The cascade's own error modes, as data

| id                                | the shape, and what cannot be done with it                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFOUNDED_CONFIG_AND_SOURCE`    | one commit rewrote the step's configuration **and** its source; two rules fire and the two explanations **cannot be apportioned from a diff**                                                                                                                                                                                                             |
| `MIXED_TEST_AND_SOURCE_COMMIT`    | one commit touched tests **and** source, so rule 1 cannot fire and the commit falls through to `SOURCE_CHANGE` — which reports a test rewrite as though it were a production change. `mixed_test_and_source_change: true` is on the record so the label alone never misleads                                                                              |
| `TEST_EDIT_MAY_MASK_A_REGRESSION` | rule 1 fired on a `FAIL→PASS`, so the only thing that changed is **what the predicate measures**. A test-only change can heal a real regression, and a deliberately relaxed assertion **cannot** be told from a corrected one. `masks_a_regression_possible: true`, and a `TEST_EVOLUTION` label is explicitly **not** a statement that the code improved |
| `PRODUCER_PACKAGE_UNRESOLVED`     | a foreign package was touched but its changed exports could not be read, so rule 2's question could not be asked. Absence of the signature is not evidence of absence of the migration                                                                                                                                                                    |
| `SIGNATURE_UNAVAILABLE`           | the failing step's output tail is not in the record, so rules 2 and 3 are **undecidable**                                                                                                                                                                                                                                                                 |
| `DIFF_UNAVAILABLE`                | the changed-path list could not be read, so every diff-reading rule is undecidable. The cascade never falls back to `SOURCE_CHANGE` on missing evidence                                                                                                                                                                                                   |

### Resume, the durable row, and what a replay can carry back

A census is resumable: `--census-session=<token>` replays the rows an earlier invocation completed and measures only
what is missing. A replayed row is **re-derived from the durable log and never re-measured**, which makes it exactly as
good as what that log stores.

The durable row is the **existing** trial-log format and the **existing** digest chain — no second ledger, no second
workspace implementation, no second provenance format. It is keyed per row by `index@commit`, which is the field a
census row actually writes.

| field on the log row                 | why it is written                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signature`                          | the classifier asks which identifiers the failing output named and which are gone afterwards. **Without it a replayed row cannot be classified at all** — the row read back as `null`, produced `SIGNATURE_UNAVAILABLE`, and reported `INCONCLUSIVE` where the fresh run reported `SOURCE_CHANGE`                   |
| `installed_tree_fingerprint_tier`    | the tier is **part of** the fingerprint. It was read back and never written, so a replayed row carried `null` where a measured row carried `content`, and the reader's own disclosure then said "it was taken at the METADATA tier … Re-measure at `--fingerprint=content`" on a range whose binding says `content` |
| everything else the derivation reads | `state`, `census_state`, `reason`, `step_scope`, `lockfile_digest`, `installed_state_digest`, `installed_tree_fingerprint`, `build_state_digest`, `gate_execution_digest`, `observed_judged_commit[_post]`, `gate_exit_code` — already persisted                                                                    |

`replay_fidelity.degraded_derivation_inputs` is **computed** on every artifact, not asserted: it lists any derivation
input a replayed row failed to carry back, and it **must be empty**. `replay_fidelity.not_persisted` names the two
fields that are deliberately absent — `environment_record` and `workspace_state`, both whole attestation blobs, neither
read by any derivation — and each replayed row carries its own `fields_not_persisted` list. A log written before
`signature` and the tier were persisted reads them as unavailable, which **is** the honest reading of a record that
never stored them. A degradation a reader cannot see is not a disclosure.

A census is therefore a **refusal to mislead about its own record**, not a claim of bit-level fidelity. Re-running a
complete session replays every row and writes nothing.

### The refusal, and the exit set

When the range is non-monotone the output states that **a single boundary is not identified**, why, and what is offered
instead. `not_offered` names `first_bad_commit`, `midpoint_selection`, `narrowing` and `bisection` so a reader does not
go looking for them. A census is **not a search**: it enumerates exactly the commits `--from..--to` names, reports every
one of them, and never narrows, halves, samples, selects a midpoint, proposes a next commit to measure, or emits a
"first bad commit". A range longer than `CENSUS_MAX_COMMITS` is **refused by name**, and the only way past it is for the
operator to name a shorter range: narrowing is their decision, not this program's.

Command-local exit codes. `3` is **never** emitted, and the SET is not the `evaluate` exit set. The two are **not
numerically disjoint**, and the record says so rather than leaving the impression: census `0` and `2` are numerically
identical to `evaluate`'s and mean different things (`exit_rule.evaluate_numeric_overlap` is `[0, 2]`). The real
discriminator is structural — `3` is an `evaluate` code and is never emitted here, and a census writes **no ledger** at
all: no `evaluations[]`, no `environments[]`, no `verification[]`, no status.

| code | meaning                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the range was enumerated in full, no commit is `ERROR`, the verdict is `MONOTONE`, and it contains no failure region. `UNDETERMINED` is **not** among the conditions that produce a `0` — it always yields `5` |
| `1`  | at least one failure **region** — a finding about a range, never a direction about one commit                                                                                                                  |
| `2`  | usage / refusal, always decided **before** any workspace was prepared, installed, built or measured                                                                                                            |
| `4`  | at least one commit is `ERROR`: a statement about **this program**, not about the history                                                                                                                      |
| `5`  | the verdict is `UNDETERMINED`: the range has a hole and carries no verdict in either direction                                                                                                                 |

Precedence is `4` outranks `5` outranks `1`, mirroring `compareRegressSides`. A refused removal is **disclosed** beside
the code and never demotes it. The printed exit **is** the process exit.

### Terminology — load-bearing

A commit under comparison is a **candidate**; a comparison reports an **observed transition** between two named commits;
a **boundary** is a candidate at such a transition. **A transition is not a cause, and a commit is never named as the
responsible party**: a candidate can be the boundary and still be innocent, which is precisely why a non-monotone
history yields regions, candidates and a refusal rather than one named commit. The fields are `candidate`, `region`,
`transition_commit` and `boundary`; there is no `cause` field and no `responsible` field to read instead.

### Standing limitations, carried unchanged

- **a worktree is not a security boundary, and historical reproducibility is not result authenticity.** A same-principal
  writer controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger, and no
  field in a census record proves a result authentic.
- a single observation per commit cannot distinguish a flaky predicate from a real difference. A census commit is
  **one** trial, and is labelled as one.
- a build executes historical code with no neutraliser; `historical_install_executed_arbitrary_scripts` and
  `historical_build_executed_arbitrary_scripts` are permanently `null`, never `true`.
- `git bisect` remains a recorded **NO-GO** with no command, no flag and no stub. The census is its non-searching
  counterpart, not a replacement for it.

## 3. Aggregate results — `.harness/state/reports/report-<timestamp>.json`

Produced by `harness.mjs report`; every invocation creates and prints a new timestamped path. Historical reports are
never overwritten. The report lists the run ids it was built from so it can be regenerated, plus `false_done_rate`,
`verification_success_rate`, `failure_categories`, duration totals and per-task counters. An explicit `--out` may
instead publish a non-causal external measurement to a new absolute target, including `/var/tmp`; it cannot become
evaluator input and cannot target the harness control plane.

### 3.1 S5 report population and denominator contract

`classifyReportPopulation()` assigns every reader file exactly one value:

| Population            | Count field               | Completed? | Enters terminal rates? | Rule                                                                                                                                               |
| --------------------- | ------------------------- | ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_evaluation` | `terminal_evaluations`    | yes        | yes                    | Gate-bearing `run_started`/`run_finished` agree; finish has an integer gate exit, matching `mechanically_verified`, and a valid matching gate log. |
| `no_gate_observation` | `no_gate_observations`    | yes        | no                     | Finish owns `gate:null`, `gate_exit_code:null`, `mechanically_verified:false`, the remaining historical run fields, and no gate log.               |
| `self_test`           | `self_test_runs_excluded` | yes        | no                     | Finish has `self_test:true`; retained as mechanics evidence.                                                                                       |
| `gate_incompatible`   | `gate_incompatible_runs`  | yes        | no                     | Finish has `gate_incompatible:true`; retained as setup evidence.                                                                                   |
| `unfinished`          | `unfinished_runs`         | no         | no                     | Structurally valid stream has one `run_started` and no `run_finished`.                                                                             |
| `invalid_run_stream`  | `invalid_run_streams`     | no         | no                     | Invalid line/root, missing/duplicate/contradictory start-finish or identity, missing/contradictory gate fields, or any gate-log defect.            |

`runs_total` is every reader file. `runs_finished` is `terminal_evaluations + no_gate_observations`; the other four
populations remain explicit counts, so no excluded file disappears when terminal denominators narrow.
`adverse_no_gate_observations` is the subset of `no_gate_observation` whose current verifier is `FAIL` or whose current
artifact integrity is `CHANGED`; it is not a seventh population and never enters the terminal success rate.

All existing terminal scalar metrics use only `terminal_evaluations`: mechanically verified, agent claimed done, false
done, acceptance pass, false-done rate, verification-success rate, failure categories, duration, runtime-metric
coverage, and telemetry. Per-task `runs` remains the terminal count; per-task rows add `terminal_evaluations`,
`no_gate_observations`, and `adverse_no_gate_observations`.

A pre-existing completed stream that omits all three historical no-gate fields is not inferred into either completed
population. It is `invalid_run_stream` and increments `historical_v1_records_uninterpreted`, following the S1 schema-1
discipline. The report never writes a population field into a run stream and never rewrites a historical run or report.

This is a local, same-principal reader classification. It prevents supported-reader denominator confusion; it is not an
authenticity, completeness, independence, or authority claim.

### 3.2 Publication and partial-state contract

| Artifact                    | Writer contract                                                                                                                                                                       | Partial, retry, reservation, and cleanup behavior                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run JSONL                   | `createWriter(eventsPath, io)` returns `{ emit, close, state }`; final path opened once with `wx`; one full-buffer write loop per complete JSON line; descriptor closes in `finally`. | State is `open`, `failed`, or `closed`. First write/close failure closes once and exits 2; later emit is `WRITER_FAILED`. Empty/partial streams and same-ID retry are invalid/refused; no auto-reclaim. |
| Gate log                    | `createGateLogWriter(logPath, io)` returns the same state contract; `runStep(step, writer, index)` emits one indexed begin/end block.                                                 | Empty, partial/unterminated, wrong order/count/command, or missing gate log for a gate-bearing run is invalid. A no-gate run must have no log. A crash may strand an empty/partial log.                 |
| Ledger initialization       | `initializeLedger(ledger, io)` serializes once, opens final path `wx`, writes all, file-fsyncs, closes.                                                                               | Existing target or caught failure exits 2. A crash can strand an empty/partial final ledger; no repair/reuse.                                                                                           |
| Ledger mutation             | `mutateLedger(ledger, io)` serializes once to a unique same-directory temporary opened `wx`, writes, file-fsyncs, closes, renames over final.                                         | Caught failure unlinks the temporary. Cross-run read/modify/write remains a race; stranded `.tmp` files are ignored. No automatic retry.                                                                |
| New report/telemetry/export | `writeNewFileExclusive(path, bytes, io)` opens final path `wx`, writes all, file-fsyncs, closes.                                                                                      | Existing target, symlink parent, relative external path, or caught failure exits 2. Caught failure unlinks the final; a crash can strand it. Same target is refused.                                    |

The empty/partial/mismatched gate-log classification is diagnostic in S2 and becomes an S5 `invalid_run_stream`; it is
never silently ignored. Per-file publication is not a cross-file transaction: a valid `run_finished` can still
contradict a later failed ledger mutation.

### Telemetry report addition (schema 2)

`harness.mjs report` adds `telemetry` without changing any run population. It counts only `run_finished.telemetry`
records that identify themselves as `schema_version: 2`. Each metric is aggregated over
`source_metric_counts.records_enumerated`, preserving `values_observed`, `values_source_null`, `values_not_recorded`,
and `values_invalid`; total, mean, and max use observed finite leaves only. With zero observed leaves, report `total`,
`mean`, and `max` remain `null` rather than fabricating zero. The mean denominator is `values_observed`, never
request-envelope count.

Schema-1 snapshots are counted in `historical_v1_records_uninterpreted` and are not reclassified or included in v2
metric counts. Their already-collapsed zero may be either an observed zero or a former missing/invalid value; the
original distinction is unrecoverable, so the report does not guess. `not_supplied_runs` and `schema_2_unavailable`
remain separate from the reader-enumerated denominator. A same-principal writer can still suppress or fabricate local
source bytes; the four states do not establish provenance or completeness.

## 4. Runtime telemetry additions to run events (optional, additive)

`run_started.experiment` — `null`, or `{ experiment, arm, role, tool_profile, mcp_profile }` with `null` for any field
not supplied on the command line. Purely attribution: no existing field changed meaning, and a reader that ignores
`experiment` sees the Initial schema schema exactly.

Runtime metrics are **not** part of this schema. Real token/cost data lives in the runtime's own task store and is
extracted separately by `harness telemetry` — see the `telemetry --scan` command in [`README.md`](../README.md)
§"Runtime commands".

## 5. Durable-state behavior additions (acceptance coverage and verifier evidence)

Additive and optional: a run that supplies none of these inputs produces the Initial schema–6 record, and a reader that
ignores the new fields sees the previous schema exactly.

| Field                            | Source                                                              | Authority                            | Meaning                                                                                                                             | Allowed values                                                                       |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `acceptance_criteria[]`          | the evaluator, from the declared checks                             | evaluator                            | per-criterion state: `{ criterion, state, checks[], detail }`                                                                       | state: `covered_pass` · `covered_fail` · `covered_error` · `uncovered`               |
| `acceptance_coverage_state`      | ditto                                                               | evaluator                            | how much of the specification was actually judged                                                                                   | `covered` · `partial` · `uncovered`                                                  |
| `acceptance_uncovered_criteria`  | ditto                                                               | evaluator                            | criterion numbers with no declared predicate                                                                                        | list of integers                                                                     |
| `acceptance_coverage_incomplete` | ditto                                                               | evaluator                            | true when a criterion is uncovered or a predicate could not decide                                                                  | boolean                                                                              |
| `verifier`                       | `--verifier-report` / `--verifier-verdict` / `--artifact-integrity` | verifier (recorded by the evaluator) | compact verifier evidence: `verdict`, `artifact_integrity`, `criteria_checked[]`, `findings[]`, `evidence[]`, `source`, `authority` | verdict: `PASS` · `FAIL` · `BLOCKED`; integrity: `UNCHANGED` · `CHANGED` · `UNKNOWN` |
| `blocked_reason`                 | the evaluator                                                       | evaluator                            | why a non-success status was reached (first matching blocker)                                                                       | string or null                                                                       |

### Integrity and human-acceptance behavior additions (INTEGRITY-PROVENANCE, HUMAN-ACCEPTANCE; also the run-event fields DOC-2 asked for)

Additive and optional, like everything above: a reader that ignores these fields sees the Initial schema–10 schema
exactly.

| Field                                      | Source                                            | Authority                    | Meaning                                                                                                                      | Allowed values                                                    |
| ------------------------------------------ | ------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `acceptance_source`                        | the evaluator                                     | evaluator                    | which mechanism produced the acceptance verdict                                                                              | `mechanical` · `human` · `none`                                   |
| `acceptance_coverage`                      | the evaluator, from the declared checks           | evaluator                    | the coverage ratio the verdict was derived from                                                                              | number 0..1, or null                                              |
| `acceptance_strict_ok`                     | the evaluator                                     | evaluator                    | the strict Strict acceptance semantics reading: the verdict is `pass`                                                        | boolean                                                           |
| `telemetry`                                | `--telemetry-store`                               | evaluator (copied)           | schema-2 copy with `status:"available                                                                                        | unavailable"`; schema-1 historical values are never reinterpreted | object; never zeros |
| `ledger_run_id`                            | the evaluator, when `--ledger` is given           | evaluator                    | identity of the selected attached ledger; its value is not terminal input                                                    | string or null                                                    |
| `ledger_status`                            | the evaluator, only for terminal/adverse outcomes | evaluator                    | omitted for ordinary no-gate; otherwise the fresh classified result                                                          | optional; otherwise a ledger status string                        |
| `gate_compatibility` / `gate_incompatible` | the evaluator                                     | evaluator                    | gate setup outcome; an incompatible gate is a setup failure, never an agent failure                                          | `gate_compatible` · `gate_incompatible` · null                    |
| `acceptance_record`                        | `--acceptance-authority/-criteria/-basis`         | caller-declared, recorded    | the five-field human acceptance act; `null` when the verdict was not a human pass; free-text authority is not identity proof | object or null                                                    |
| `acceptance_record_classification`         | the evaluator                                     | evaluator                    | whether that human pass was attributed to a named authority                                                                  | `attributed` · `operator_trust` · `not_applicable`                |
| `verifier.artifact_integrity_basis`        | `--artifact-integrity-basis` (required)           | verifier/operator (recorded) | one bounded line: WHO/HOW the integrity observation was produced                                                             | string ≤400 chars, or null                                        |
| `verifier.artifact_integrity_kind`         | `--artifact-integrity-kind`                       | verifier/operator (recorded) | whether that observation is computed evidence or a declaration; it never defaults to `computed`                              | `computed` · `declared`                                           |
| `ledger.integrity_clearances[]`            | the evaluator                                     | evaluator                    | append-only: which kind of evidence cleared a standing `artifact_integrity_changed` block                                    | `{ at, run_id, cleared_by, basis, clears_kind }`                  |

**HUMAN ACCEPTANCE RECORD** (HUMAN-ACCEPTANCE, five fields, fail-closed): `mechanism` (always `human`), `authority` (who
accepted), `covered_criteria` (non-empty subset of `1..acceptance.length`), `basis` (one bounded line ≤400 chars),
`recorded_at`. An unknown field, an out-of-range or duplicated index, or a missing authority/scope is **rejected**,
never normalised. A `--acceptance=pass` with **no** record stays legal and is recorded as
`acceptance_record_classification: operator_trust` — a persisted classification for caller-declared operator trust,
never measured evidence or authenticated identity. The record never changes `coverage_state` and never grants a terminal
state by itself.

### S4 current-fact derivation and completed no-gate observations

`classifyLedgerStatus` accepts exactly `{ gateResult, acceptance, acceptanceCoverage, verifier, integrityVeto }`.
`gateResult` is `pass | fail | incompatible | not_run`; `integrityVeto` is
`none | unresolved | cleared_by_current_unchanged`; the other values are current invocation facts. The signature has no
loaded ledger, report, run, transition, generic state/options object, persisted contract copy, or rest/spread parameter.
The classifier is therefore structurally unable to read the 12 durable field families. Their only retained causal
exception is the normalized unresolved integrity veto on the same identity-valid selected ledger; it blocks but never
promotes.

A completed `--no-gate` run still has `gate:null`, `gate_exit_code:null`, and `mechanically_verified:false`; it creates
no gate log and exits `1`. Ordinary no-gate `run_finished` omits `ledger_status`, emits no `ledger_updated`, and leaves
an attached ledger byte-identical. Current verifier `FAIL` records `ledger_status:failed` and mutates the attached
ledger; current artifact `CHANGED` records `ledger_status:blocked` and the integrity blocker. No-gate `UNCHANGED`
neither clears a standing veto nor mutates. Malformed, duplicate, unsafe, and identity-mismatched attachments are
refused with exit `2` before run creation.

The 12 non-causal families are: (1) identity/selection, (2) lifecycle/quality, (3) recorded work/blockers/clearances,
(4) acceptance snapshots/coverage, (5) verifier/integrity snapshots, (6) gate/workspace snapshots, (7) run identity and
sequencing, (8) contract/policy copies, (9) persisted human/verifier inputs, (10) report/selection state, (11)
persistence/migration metadata, and (12) prior publication/qualification artifacts. Structural API narrowing makes all
12 non-causal without adding twelve products.

These controls are **qualification**, not prevention of the same-principal class. A writer controlling the current gate,
contract, acceptance policy, verifier input, dependencies, evaluator, or downstream consumer can still manufacture a
fresh local `verified` result.

Semantics that go with the fields (Evaluator state state machine, fail-closed):

```text
gap = PASS  and  coverage incomplete        → acceptance is NOT pass, status = blocked
verifier FAIL                                → status = failed (a green gate cannot override it)
verifier PASS                                → never promotes; the evaluator still needs acceptance evidence
artifact_integrity CHANGED                   → the verdict is unusable: status = blocked
artifact_integrity UNKNOWN                   → preserved as UNKNOWN, never upgraded
                                               omitting verifier evidence does not lift it

                                               omitting verifier evidence does not lift it
```

**Backward compatibility.** Historical ledgers and run documents lack these fields. Readers must treat
`verifier === undefined`, `acceptance_criteria === undefined` and `blockers === undefined` as "not recorded", i.e. the
same as `null`/`[]`; nothing is inferred, and no historical run is rewritten. Telemetry consumers likewise select on
`schema_version`: schema 1 remains historical/lossy, while only schema 2 carries the four reader-derived states and
`records_enumerated` arithmetic.

### STATE-MODEL ledger addition — status-transition history (optional, additive)

Execution-state ledgers may carry `transitions[]`. The durable authority remains `ledger.status`; this array only
records how the current value was reached.

| Field    | Type           | Meaning                                                                                        |
| -------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `at`     | ISO string     | when the status changed                                                                        |
| `from`   | status string  | previous durable status                                                                        |
| `to`     | status string  | new durable status                                                                             |
| `source` | string         | `evaluator` or `agent`                                                                         |
| `cause`  | string         | bounded CLI cause: `harness evaluate` or `harness ledger set`                                  |
| `run_id` | string or null | evaluator run id (≤200 chars) when a run caused the change; null for an operator/agent command |
| `reason` | string or null | optional bounded cause note (≤400 chars)                                                       |

`harness ledger set` and `harness evaluate` append one entry only when `ledger.status` actually changes. The array has
no cap beyond actual status changes: a run that does not change status adds nothing, and one status-changing invocation
adds at most one entry. `classifyLedgerStatus`, coverage computation, `deriveBlockers`, `hasUnresolvedIntegrityBlocker`
and the acceptance pipeline do not read this field and must remain unchanged by it.

This is **observability, not authority**. It is not a control, veto or gate, and it confers no integrity guarantee. The
ledger remains an ordinary writable JSON file: there is no hash chain, signature, tamper evidence or at-rest protection,
so direct writes may alter or remove the history.

**Backward compatibility.** A ledger written before STATE-MODEL has no `transitions` property. Readers treat it as **not
recorded**, exactly like a missing observation; they never infer transitions from verification or blockers. No migration
rewrites such a ledger. Human `ledger show` displays `not recorded`; `--json` exposes the missing property as `null`.

## 7. Strict operational ledger schema and inventory

This section governs read-time operational use of `.harness/state/ledgers/*.json`. It does not migrate, repair, rename,
delete, or normalise a stored record. Strict validation is same-principal hardening, not isolation or authenticity.

### 7.1 Parser primitives

`parseStrictJson(raw, { maxBytes: 1048576, maxDepth: 32, rejectDuplicateKeys: true })` returns `{ok:true,value}` or
`{ok:false,code,detail}`. Error precedence is `LEDGER_TOO_LARGE`, `LEDGER_INVALID_UTF8`, `LEDGER_INVALID_JSON`,
`LEDGER_DUPLICATE_KEY`, `LEDGER_TOO_DEEP`, `LEDGER_NOT_OBJECT`. The root object is depth 1. Comments, trailing commas,
unquoted keys, duplicate keys at any depth, trailing content, `NaN`, and `Infinity` are invalid.

Primitives:

- `Timestamp`: `YYYY-MM-DDTHH:mm:ss[.fraction]Z`, fraction 0..3 digits, valid UTC calendar date/time; offsets are
  invalid.
- `Token` / `RunToken`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`.
- `GitHex`: `^[0-9a-f]{7,40}$`.
- `Text(n)`: JavaScript string length 1..n; `OptText(n)` is `Text(n)` or null.
- `NonNegInt`: JSON integer >= 0. `Unit`: finite JSON number 0..1 inclusive.
- `CountMap`: at most 200 keys; each key `Text(200)` and value `NonNegInt`; map keys are data, not control fields.
- At every object depth, unknown sibling keys are tolerated, retained, and never interpreted. A present known key with
  the wrong type, enum, bound, timestamp, required nesting, or cardinality is `LEDGER_SHAPE_INVALID`.

### 7.2 Root and nested records

Required root fields are `version:1`, `run_id:RunToken`, `task_id:Token`, `title:Text(1000)`, `source_commit:GitHex`,
`workspace:Text(1024)`, `gate:Gate`,
`status:pending|in_progress|verification_pending|verified|failed|blocked|interrupted|aborted`, unique
`acceptance:Text(4000)[1..500]`, `completed|pending|claims:WorkItem[0..10000]`,
`verification:VerificationItem[0..10000]`, `failures:FailureItem[0..10000]`,
`invalid_transitions:InvalidTransition[0..10000]`, and `created_at|updated_at:Timestamp`.

Optional root fields are `arm:OptText(200)`, `transitions:Transition[0..10000]`,
`resolved_pending:ResolvedPending[0..10000]`, `acceptance_verdict:pass|fail|unresolved|unknown`,
`acceptance_mechanism:mechanical|human|none|unknown`, `acceptance_coverage:Unit|null`,
`acceptance_checks:AcceptanceChecks`, `acceptance_record:null|HumanAcceptance`,
`acceptance_record_classification:attributed|operator_trust|not_applicable`, `verifier:null|Verifier`,
`blockers:Blocker[0..10000]`, `integrity_clearances:IntegrityClearance[0..10000]`,
`telemetry:TelemetryV1Stored|TelemetryV2Task`, and `evaluations:Evaluation[0..10000]`.

- **Gate:** required `name:Text(120)`, `compatibility:gate_compatible|gate_incompatible|null`,
  `checked_at:Timestamp|null`, `problems:Text(1000)[0..100]`.
- **WorkItem:** `at:Timestamp`, `text:Text(4000)`, `source:agent|evaluator|human|gate|gate_compatibility`.
- **Transition:** `at`, root-status `from|to`, `source:evaluator|agent`, `cause:harness evaluate|harness ledger set`,
  `run_id:RunToken|null`, `reason:OptText(400)`.
- **ResolvedPending:** `at`, `text:Text(4000)`, `source:Text(64)`, `resolved_by:RunToken`, `resolved_at`.
- **VerificationItem / Step:** item has `at`, `run_id`, `gate:Text(120)`, `command:OptText(2000)`, `exit_code:0..255`,
  finite `duration_ms>=0`, `mechanism:evaluator`, `steps:Step[0..1000]`; step has `step:Text(120)`,
  `command:Text(2000)`, `exit_code:0..255`, finite `duration_ms>=0`.
- **FailureItem:** `at`; `category` in the published taxonomy; `source:agent|human|gate|gate_compatibility`;
  `note:OptText(400)`. **InvalidTransition:** `at`, `attempted_status:Text(64)`, `reason:Text(400)`.
- **AcceptanceChecks:** required `verdict:pass|fail|unresolved`, `criteria_total/criteria_covered:NonNegInt`,
  `coverage:Unit|null`, `criteria:0..10000` and `coverage_state:covered|partial|uncovered` may be absent for history,
  otherwise `Criterion[]`; `failed|errored:CheckIssue[0..10000]`, unique positive `uncovered_criteria:0..10000`,
  `mechanism:mechanical`. Criterion is
  `{criterion:positive integer,state:covered_pass|covered_fail|covered_error|uncovered,checks:Text(200)[0..100],detail:Text(2000)}`.
  CheckIssue is `{id:Text(200),detail:Text(2000)}`.
- **HumanAcceptance:** exactly `mechanism:human`, `authority:Text(200)`, unique positive `covered_criteria:1..500`,
  `basis:Text(400)`, `recorded_at`; unknown/missing fields are invalid.
- **Verifier:** `at`, `run_id:RunToken|null`, `source:handoff|flags|none`, `verdict:PASS|FAIL|BLOCKED`,
  `artifact_integrity:UNCHANGED|CHANGED|UNKNOWN`, `artifact_integrity_basis:OptText(400)`,
  `artifact_integrity_kind:computed|declared`, `criteria_checked:Text(400)[0..20]`, `findings:0..10`,
  `evidence:Text(400)[0..10]`, `authority:Text(400)`. Finding is either `{text:Text(400)}` or an object with
  `requirement|mechanism|evidence:OptText(200)`.
- **Blocker:** `at`, optional `kind:artifact_integrity_changed|acceptance_coverage_incomplete`, `text:Text(2000)`,
  `source:evaluator|agent`, optional `run_id:RunToken|null`. Only exact `artifact_integrity_changed` participates in the
  retained standing veto. **IntegrityClearance:** `at`, `run_id:RunToken`, `cleared_by:computed|declared`,
  `basis:OptText(400)`, `clears_kind:artifact_integrity_changed`.
- **Evaluation:** every key is REQUIRED and every observation is NULLABLE, because the writer normalises each optional
  observation to `null` on write. `at:Timestamp`; `run_id:RunToken` (the only join key to `verification[]`);
  `declared_source_commit:GitHex|null`; `judged_commit_pre|judged_commit_post:40 lower-case hex|null` (**never an
  abbreviation** — a prefix is what makes two commits confusable); `judged_commit_basis:observed` (single-valued; a
  declaration is never relabelled as an observation);
  `judged_commit_scope:primary_repo|linked_worktree_of_this_repo|unrelated_tree|null`; `judged_cwd:OptText(1024)`;
  `status_hash_pre|status_hash_post|lockfile_digest:12 lower-case hex|null`; `gate:OptText(120)` — nullable because the
  writer normalises an absent, blank or over-long gate name to `null`, and the reader accepts exactly what the writer
  can emit (a reader that demanded more would refuse a ledger this evaluator itself wrote, and `loadLedger` fails
  closed, so the disagreement would brick the ledger on the NEXT read, not at write time);
  `gate_definition_sha256|contract_digest:16 lower-case hex|null`;
  `acceptance_contract_schema_version:positive integer|null`. `run_id:RunToken` in this entry and in `verification[]` is
  a **string** or `null`: the token grammar is tested against a value whose type is checked first, so a number or
  boolean cannot pass. A wrong type, an unknown `basis` or `scope` value, or a short/abbreviated judged commit is
  `LEDGER_SHAPE_INVALID`; `null` is always valid.

### 7.3 Stored telemetry union

Telemetry is observational. `TelemetryV1Stored` is the historical wrapper
`{status:observed|unavailable, reason:OptText(400),store_task_id:Text(200)|null,observed:LegacyMessages|null,derived:LegacyDerived|null, unavailable_metrics:CountTextMap|null}`.
Legacy messages use `CountMap`, `NonNegInt`, finite numbers, `Timestamp|null`, and the historical request fields from
the stored schema. `LegacyDerived` has `cache_read_share_of_prompt_tokens:Unit|null` and
`mean_cost_per_request:finite>=0|null`. CountTextMap has at most 20 `Text(200)` keys with `Text(1000)` values.

`TelemetryV2Task` requires `schema_version:2`, `extracted_at:Timestamp`, `store:Text(4096)`, `task_dir:Text(4096)`,
`task_id:Token`, boolean `files_present`, and acquisition `available/reason:null` or `unavailable/reason:Text(400)`.
Available v2 uses the published observed messages, five fixed metric aggregates and state counts, derived fields, and
six-key `unavailable_metrics`; unavailable v2 requires `observed`, `derived`, and `unavailable_metrics` all null. No v1
aggregate is reinterpreted as v2.

### 7.4 Identity, inventory, and refusal

Operational use requires requested run ID = filename stem = embedded `run_id`, embedded `task_id` = selected task, and
full validation. Inventory precedence is: parser/regular-file failure → `rejected`; parseable identity mismatch →
`forensic_only` even with shape diagnostics; identity-matching shape failure → `rejected`; otherwise
`operational_valid`. Default selection uses only `operational_valid` rows for the exact task, then `updated_at`
descending and `run_id` descending.

Missing field, wrong type, bad enum, out-of-bounds, bad timestamp, and malformed known nesting all exit 2 with
`LEDGER_SHAPE_INVALID`; unknown keys are accepted data. Duplicate keys exit 2 with `LEDGER_DUPLICATE_KEY`; oversize with
`LEDGER_TOO_LARGE`; depth over 32 with `LEDGER_TOO_DEEP`; malformed JSON with `LEDGER_INVALID_JSON`; invalid UTF-8 with
`LEDGER_INVALID_UTF8`; non-object root with `LEDGER_NOT_OBJECT`. No run is created for any refusal.

`ledger forensic --run-id=<id> [--json|--raw]` runs before task lookup, forbids `--task`, and is permanently non-causal.
It shows only bounded path, length, SHA-256, parse/identity facts, diagnostics, and either exact raw bytes or JSON
`mode:forensic_observation`, `causal:false`, those facts, and a human statement. It has no status/suitability/terminal
field. The command itself cannot attach, mutate, classify, or select terminal state, but this is path-local rather than
content provenance: exact bytes copied to an identity-matching filename can become operational. Raw streaming is capped
at 16,777,216 bytes; one byte more exits 2 with `FORENSIC_INPUT_TOO_LARGE` before any output.

## 8. External material is never a measurement input

Material retrieved from outside the repository — a fetched page, a linked article, a quoted third party, a research
observation — is an **observability artifact**, not a measurement. It may inform task framing, contract drafting before
a contract is frozen, executor decisions, and the bounded `basis` of a human-acceptance record. It **must never** be a
gate command, a gate predicate, an acceptance predicate, a verifier-promotion input, or a source of terminal status.
This preserves the causal-control boundary: a causal control is not derived from external material.

Three consequences:

- **Claim is not verification.** A retrieved document asserts; a program observes. A gate result comes from running the
  gate, never from a citation about it.
- **Reproducibility is not provenance, and neither is authenticity or authorization.** That a body can be fetched again
  says nothing about who wrote it, when, or under which policy; a content hash over retrieved bytes is a fact about
  bytes, not about authorship.
- **A discovery result is not a cited source.** A search result or a summary somebody else wrote about a page is not the
  page, and may not support a human-acceptance `basis`. A cited claim requires a bounded quote from the source itself,
  with the retrieval time attached — a later differing retrieval is a new observation, not evidence that the earlier one
  was false.

These rules stand on their own: they are stated here as the rule, not as the history of a tool.

---

## §3 — The evaluate verdict (`harness.evaluate.verdict/1`)

`evaluate --json` prints one JSON object on the last line of stdout, after the human summary. It is a **projection** of
the run stream, not a new tier of evidence and not a new record: the full stream is still written in full, and deleting
the verdict loses nothing. It is disposable; the run stream is durable.

It exists because the decision is otherwise unreachable: the decision fields are a small fraction of the run stream,
scattered across many sibling keys, and two facts a consumer _needs_ — this run's own id and the instant it measured —
would otherwise be written nowhere at all.

### Fields

| Field                          | Type            | Meaning                                                                                                                                                                                                                   |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                       | string          | `harness.evaluate.verdict/1`. The version is in the value, so a consumer can refuse an unknown one.                                                                                                                       |
| `verdict`                      | enum            | `GATE_PASS` \| `GATE_FAIL` \| `NOT_A_GATE_PASS`. `GATE_PASS` is **reserved for `scope: FULL_GATE`** — see below. `NOT_A_GATE_PASS` is load-bearing: it is what stops "the step passed" collapsing into "the gate passed". |
| `scope`                        | enum            | What the run actually covered. **Mandatory** — see below.                                                                                                                                                                 |
| `run_id`                       | string          | This run's own id, tying the verdict back to its run stream. Fourth key of the head, so a stale verdict is not byte-identical to a fresh one.                                                                             |
| `measured_at`                  | string          | ISO-8601 instant the measurement was taken, so two verdicts of one commit can be ordered. Fifth key of the head.                                                                                                          |
| `judged_commit`                | string or null  | The commit the gate judged, full 40-hex. Observed, not declared.                                                                                                                                                          |
| `judged_source_status_hash`    | string or null  | Digest of the judged source tree's `git status`. Distinguishes a CLEAN tree from an UNCOMMITTED EDIT at the same commit.                                                                                                  |
| `commits_since_source`         | array           | Bare 40-hex shas between the contract's declared `source_commit` and what was judged. Bounded; carries no commit text.                                                                                                    |
| `declared_source_commit`       | string or null  | The contract's declared `source_commit`, or `null` on a contractless run.                                                                                                                                                 |
| `gate_bearing`                 | boolean         | Whether a gate ran and produced a result. because it existed nowhere.                                                                                                                                                     |
| `steps_run`                    | integer         | Steps that ran.                                                                                                                                                                                                           |
| `steps_total`                  | integer         | Steps the selected gate has. because it existed nowhere — and its absence is what made `check` and `check:fast` indistinguishable.                                                                                        |
| `gate_exit_code`               | integer or null | The gate's exit code, or an explicit `null` for an UNDEFINED step, for `GATE_INCOMPATIBLE` and for `--no-gate`. **Never `0` for "nothing ran."**                                                                          |
| `aborted_after`                | string or null  | The step the fail-fast stopped at.                                                                                                                                                                                        |
| `gate` / `step` / `step_state` | string or null  | The gate, the requested step, and whether that step is `runnable` or `UNDEFINED`.                                                                                                                                         |
| `failure_category`             | string or null  | The derived failure category, or `null`.                                                                                                                                                                                  |
| `contract_digest`              | string or null  | Digest of the contract's acceptance surface, or an **explicit `null`** on a contractless run.                                                                                                                             |
| `contractless`                 | boolean         | Whether no contract was attached.                                                                                                                                                                                         |
| `steps`                        | array           | `[{ step, exit_code }]`.                                                                                                                                                                                                  |
| `acceptance`                   | object          | `{ verdict, source, seeded, coverage, uncovered }`. `verdict` is `unknown` until a human or `--acceptance` supplies one. `seeded` is `true` only for a contract `contract init` derived.                                  |
| `environment`                  | object          | A **selection** from the 110-field environment record — see below.                                                                                                                                                        |
| `prior_observations`           | object          | A memory of earlier runs of this judged state — see below.                                                                                                                                                                |
| `events`                       | string          | Path to the run stream, which remains the durable record.                                                                                                                                                                 |

Every optional field is normalised to an explicit `null` on write. A historical run stream has neither `gate_bearing`
nor `steps_total`, and both read as "not recorded" — which is what a field's absence has always meant.

### Field order is part of the contract — and it is an ORDER, not a byte window

The **head** is an **ordered list of NINE keys**, in this order, at the front of the object: `schema`, `verdict`,
`scope`, `run_id`, `measured_at`, `judged_commit`, `declared_source_commit`, `judged_source_status_hash`,
`commits_since_source`. A run whose judged commit differs from the contract's declared `source_commit` is not a
statement about that baseline, and that fact existed in the record while being printed at byte ~2 200 of a human
summary, where an agent reading the decision never reached it. Both commit names are in the head, and the freshness and
tree fields follow them (`E26-10`, `E27-03`, `E27-04`, `E28-04`).

**The head is an ORDER, not a byte window, and no byte window is promised.** The byte positions follow from the values
(a contractless run writes `declared_source_commit: null` and moves them earlier); the ORDER is the contract, and it is
what a consumer may rely on.

**A seven-key head cannot fit in 200 bytes under any assignment of values, and that is computed rather than asserted.**
`verdictHeadByteFloor()`: a seven-key JSON object prefix with every value empty is **112** bytes; the two 40-hex commits
add **80**; that is **192**, which leaves **8** bytes for `verdict`, `scope`, `run_id` and `measured_at` together —
while `schema`'s own value is **28** bytes including its quotes, so filling in `schema` alone puts the head at **218**.
There is no assignment of shorter ids or timestamps that brings it under.

**The order is worth what it costs.** Freshness is in the head because a stale head that is **byte-identical** to a
fresh one is a hazard that confirms the wrong reading, while a commit name a few dozen bytes later is still in the head
and still on the same line of the same object. **No field is removed, reordered or shortened to hit a byte count, and
the head is not shrunk.** `E26-10` and `E28-04` assert the order and measure the offsets this section quotes.

### `scope` — what the run actually covered

`scope` is **mandatory** and is computed **in-process**. `GATES` is a module-local constant and the canonical step list
is recorded nowhere durable, so a consumer re-deriving scope from the stream would have to hardcode what `check:fast`
omits — the duplication that rots.

| `scope`             | Meaning                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `FULL_GATE`         | Every step of the canonical `check` gate ran and exited 0. This is whole-project validation.                                                |
| `SUBSET_GATE`       | A real gate passed, but it is a **strict subset** of `check` (e.g. `check:fast`). **Not** the same as `FULL_GATE`.                          |
| `SINGLE_STEP`       | One named step of the gate ran (`--step`). One step is not the gate.                                                                        |
| `PARTIAL_FAIL_FAST` | The gate stopped at its first failure; the steps after it were **not measured**.                                                            |
| `UNDEFINED`         | The named step does not exist in this workspace's manifests. Nothing ran, the exit code is an explicit `null`, and this is never a failure. |
| `GATE_INCOMPATIBLE` | The gate cannot resolve here. No step ran; this is a **setup** failure, not an agent failure.                                               |
| `NO_GATE`           | `--no-gate`: state and events were captured and no gate ran.                                                                                |

**Why this is load-bearing.** A summary that prints `steps run: N of N` / `gate exit: 0` / `mechanically_verified: yes`
/ `failure category: none` is each line individually true, and together it is a trap: an agent that reads exit 0 as "the
project validates" is wrong whenever the gate was a subset or a single step. `scope` is the only field that separates
them, which is why it is mandatory.

### `GATE_PASS` is reserved for `FULL_GATE`

`scope` alone is not enough, because `verdict` is field 2 of the object and an agent told "if it says the change is
validated, you are done" reads the first and the exit code. `GATE_PASS` is therefore emitted for `scope: FULL_GATE` at
exit 0 and **for nothing else**: `SUBSET_GATE`, `SINGLE_STEP` and `NO_GATE` at exit 0 are all `NOT_A_GATE_PASS`. A
`GATE_FAIL` is still `GATE_FAIL` on every real-gate scope — suppressing a failure would lose information to buy nothing,
because a failure is not what a hurried reader mistakes for a pass.

`GATE_INCOMPATIBLE` additionally reports `gate_exit_code: null`, so a consumer branching on `=== 0` cannot conclude the
gate passed on a run where no step ran. One function decides the value (`evaluatedGateExitCode`), so the
`UNDEFINED`-step null and this one cannot drift apart.

### The machine surface: the LAST line of stdout, and the only literal token

**The contract.** The machine surface is the **last line of stdout**, and the literal string
`harness.evaluate.verdict/1` appears **exactly once** in the whole of stdout, on that line. A consumer may therefore
`tail -1`, or `grep -m1 'harness.evaluate.verdict/1'` and get the right answer; both are correct by construction rather
than by luck.

**Why both halves.** Each half alone leaves a hole: neutralising the token inside fenced gate output still leaves a
determined consumer parsing a fence, and defining the surface as "last line only" still leaves a `grep` reaching a
forged object. The fence defeats _line-prefix_ matching (a forged `mechanically_verified: yes` renders as
`| mechanically_verified: yes`), but a substring search would still hit the **forged** line first — on a genuinely
failing run a grep-and-parse consumer got `GATE_PASS / gate_exit_code: 0` while the real verdict was `GATE_FAIL` and the
process exited 1. So the literal token is **neutralised** inside fenced gate output — replaced by
`harness.evaluate.verdict∕1` (U+2215, one character different, so it still reads to a human) — and the real verdict is
emitted last. The threat is a substring search, so the token is neutralised rather than escaped.

**This is a presentation boundary, not an authenticity claim.** Neutralising a token says nothing about who produced the
surrounding bytes: a same-principal writer controls the gate, the contract, the dependencies, the evaluator and the
ledger, and can still manufacture a fresh result. A worktree is not a security boundary and result authenticity is not
claimed. What the contract buys is that a consumer following it is not _misled by this program's own output_ — nothing
more. (`E27-06` pins all three halves.)

### `environment` — and what each digest is not

A **selection**, not a copy: the full 110-field record stays in the run stream and the ledger. The block exists so two
runs of one commit can be compared without opening either stream — an `installed_state_digest` drift between them was
detected and completely invisible (`E26-09`).

`installed_state_digest` is **npm's own account** of the tree (`node_modules/.package-lock.json`), labelled
`declared_by_npm` in its `installed_state_digest_basis` and never presented as an observation of the bytes.
`installed_tree_fingerprint` is a separate, differently-named observation made by walking the tree at a named tier, and
its exclusions are what it did not cover. `gate_env_policy` names whether the gate child environment was `sanitised` or
`inherited`. A digest printed without its basis is an authority claim; these never travel without one.

### `prior_observations` — a memory, not a verdict

Prior runs of **this exact judged state**, read from the run streams already on disk with **zero extra gate
executions**. Grouping key, read from `run_started`:

`judged_commit` · `contract_digest` · `judged_source_status_hash` · `gate` · `step`

Two of these are measured corrections rather than preferences:

- **`run_started`, not `run_finished`.** `run_finished` leaves `judged_commit` and `contract_digest` null on some
  records; a key built on those collapses distinct states into one group.
- **`judged_source_status_hash`, not `status_hash_pre`.** `status_hash_pre` digests `git status --porcelain`, and
  `.harness/` is **untracked** in this repository — so every run this harness performs writes a run stream and _changes_
  that hash. A key on it put every run of one commit in its own group and left the memory permanently empty. The
  noise-filtered sibling is a function of the judged **source**, which is what the grouping needed.

It reports
`{ caveat, caveat_code, n, distinct_gate_exit_codes, contradicted, by_step, streams_read, streams_considered, truncated, basis }`,
and **`caveat` and `caveat_code` LEAD**: JSON key order is the contract here, so a consumer reading the first fields
cannot reach an unqualified `contradicted: false` without having passed the caveat. That ordering is asserted
positionally (`I29`, `E27-07`), because a comment saying "leads" is not a property. `caveat_code` is a lowercase machine
token (`history_not_corroboration_order_coupling_unobservable`) for a consumer that wants the residual without parsing
prose. The human sentence is likewise split: at `n === 1` it says one run **cannot** agree or disagree with anything,
instead of "those prior runs agreed with each other" — one run agreeing with nothing reads as corroboration. The
mechanism is unchanged and asserts nothing: `n=2 codes=[0] contradicted=false` on the first red run is inherent to
reading history rather than repeating, and the field resolves nothing in either direction.

### `judged_source_status_hash` and `commits_since_source` — a difference, not a cause

These two exist because `judged_commit` cannot distinguish a clean tree from an uncommitted edit at the same commit,
which is the entire test-manipulation surface: append a line to a tracked file and `judged_commit` is identical either
way. They are the **disclosed alternative to a test-edit classifier**, which this harness does not ship.

**What they support:** a consumer can tell a clean tree from a dirty one, and can see how far HEAD has moved from the
contract's declared baseline. `commits_since_source` holds **bare 40-hex shas** (`git log --format=%H`, not
`--oneline`): a commit _subject_ is unbounded repository content and would make a field whose purpose is fixed-width
comparison a function of whatever text an author wrote.

**What they do not support, stated here so they cannot be read as more:** they are **not** a test-edit detector and not
a masking classifier, and they cannot say which file changed, let alone whether it was a test. The design rejected that
classifier — a heuristic with an unmeasured false-positive rate sitting beside a field called `mechanically_verified` is
exactly the arbitrary confidence score the mission rules out — and the reviewer agreed. There is no `test_manipulation`
field and no `confidence` field, and none is built. These disclose a **difference**, not a cause.

### Freshness: `run_id` and `measured_at`

A green verdict saved to a file and read back after an edit would still say `GATE_PASS` and `judged_commit` would still
**match HEAD**, so the one freshness check an agent would naturally reach for would _confirm_ the stale read. `run_id`
and `measured_at` are in the head (see "Field order is part of the contract" above), so two verdicts of one commit at
different times are different bytes and a consumer can order them without a clock of its own.

**It asserts nothing.** No rate, no bound, no exchangeability assumption, and no guarantee of any kind — the words
"stable", "confirmed" and "reproducible" appear in neither the field names nor the basis string. It says one thing:
these prior runs of this state disagreed. **What it cannot separate** is stated in its own `basis`: it reads runs that
already happened, so a defect coupled to trial-index parity, to the absolute order of gate executions in a session, or
to a one-shot resource stays consistent across every prior run and cannot be told from a real difference. Any schedule
is periodic, so a defect periodic with it is aligned by construction. This is the same residual the interleaved repeat
schedule has, and it is recorded rather than engineered away.

## §3a — The `evaluate` exit table

`--help` prints this table, and it is generated from the single constant `EVALUATE_EXIT_TABLE` that the exit site is
documented against, so the help and the code cannot drift into disagreeing about what a number means.

| Exit | Invocation                                                                                                                                                   | Scope / note                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `0`  | a gate-bearing run whose steps all exited 0                                                                                                                  | `FULL_GATE` / `SUBSET_GATE`                                     |
| `0`  | a single named step (`--step=<name>`) that **passed**                                                                                                        | `SINGLE_STEP` — one step, **not** the gate                      |
| `1`  | a gate-bearing run with a step that exited non-zero                                                                                                          | `FULL_GATE` / `SUBSET_GATE` / `PARTIAL_FAIL_FAST`               |
| `1`  | a single named step that failed, or one that is `UNDEFINED`                                                                                                  | `SINGLE_STEP` / `UNDEFINED` — nothing was spawned               |
| `1`  | `--no-gate`, or a ledger-attached run whose derived status is not `verified`                                                                                 | `NO_GATE`                                                       |
| `2`  | a refusal **before anything was measured**: unknown flag, unknown step name, unusable `--fingerprint` tier, unusable `--gate-env` policy, a stray positional | no run stream was written                                       |
| `3`  | `gate_incompatible` — the gate cannot resolve in this workspace                                                                                              | `GATE_INCOMPATIBLE` — a **setup** failure, not an agent failure |

`regress` and `census` publish their **own** command-local exit sets (documented in `--help` above their own sections).
`3` is never emitted by either of them. No code was added and none was removed.

### The one row whose meaning changed

**A passing `--step` exits `0`; a failing one exits `1`.** Two states of the _same_ measurement must not share an exit
code. `scope` is what keeps that `0` from being read as a whole-gate pass — it is `SINGLE_STEP`, never `FULL_GATE`, and
it is in the printed summary, in the verdict, and in the run stream. A per-step run derives **no** terminal state,
leaves the ledger byte-identical, and reports `mechanically_verified: no`. An `UNDEFINED` step exits `1`: nothing ran,
so there is no pass to report.

One row stays as it is: `evaluate` with no `--task` exits 1 where `ledger` with no `--task` exits 2. Changing it would
alter the meaning of a code many callers already branch on, and the refusal text already names the missing flag.

## §3b — Unknown flags and stray positionals

An unknown flag and a stray positional are both refusals:

```
$ harness evaluate --task=FIX1 --acceptence=pass
error: unknown flag for `evaluate`: --acceptence
  accepted by `evaluate`: --acceptance --acceptance-authority … --workspace
  refused because: <UNKNOWN_FLAG_BASIS>
  exit: 2 (nothing was created, installed, prepared or measured)
```

A silent drop is the worst class of bug on a command line: a real capability was requested with a typo, was not granted,
and the run still reported success — and it is undetectable afterwards, because the run stream never records a flag the
run did not read. The refusal happens before any workspace, install or gate.

The allowlist is **per command, and per subcommand** where a command has them (`COMMAND_FLAG_ALLOWLIST`), derived from
the flags those code paths actually read _including the ones read indirectly_ — through `resolveGateName`,
`resolveStepFlag`, `resolveVerifierEvidence`, `workspaceInstance`, `collectExperimentContext` and
`collectRuntimeMetrics`. It is a **superset** of what each command reads today, so no existing invocation changes
meaning.

One entry deserves its own note: `workspace prepare` **accepts but does not read** `--step`. `regress` and `census` both
carry a named step down to the preparation so that both sides of a comparison are prepared under the same request and
their attestations stay comparable; the per-step _applicability_ question is answered by `evaluate` in the prepared
workspace. Refusing the flag there would break that contract.

**A stray positional is a refusal too.** `workspace <sub>` and `ledger <sub>` take exactly one, consumed by the
dispatcher before the flag boundary; `show <id>` and `validate <id>…` never reach `parseFlags`; every other command
takes none. `evaluate COMPAT` is therefore refused rather than treated as `evaluate --task=COMPAT` (`E26-01`, `E26-02`).
