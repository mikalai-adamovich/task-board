# Agent harness

The harness is a local task-evaluation and durable-state utility. Runtime modules live in `runtime/`, gate code in
`tests/`, operator utilities in `operator/`, normative formats in `docs/`, and generated or future state in `state/`.

> **TERMINOLOGY — load-bearing.** A commit under comparison is a **candidate**. A comparison reports an **observed
> transition** between two named commits, and a **boundary** is a candidate at such a transition. **A transition is not
> a cause**: the harness measures what two commits did, and a difference between them is a fact about the pair, never a
> statement about which commit is responsible for anything. A commit is therefore **never named as the responsible
> party** — a candidate can be the boundary and still be innocent, which is the whole reason `INCONCLUSIVE` is
> non-resolving. Self-test group `I26` and compatibility case `E24-08` assert that the forbidden word appears nowhere in
> the runtime or in any of these documents **outside the quoted `git bisect` NO-GO falsifier below**, which names it
> inside a criterion about what a skip would suppress and which is asserted to still be there.

## Contents

`Operator entry point` · `Normative documentation` · `Runtime commands` ·
`The decision surface — what an agent should read` · `Gate and tests` · `Ledgers` · `Historical workspaces` ·
`Two-commit comparison` · `History census` · `Terminal-evaluation control` · `Permanent class limitation` ·
`Reporting verification`

The normative detail lives in [`docs/schemas.md`](docs/schemas.md) (record contracts, field tables, exit tables) and
[`docs/ledger.md`](docs/ledger.md) (ledger loading, lifecycle, forensic access).

## Operator entry point

- Runtime CLI: `node .harness/runtime/harness.mjs <command>` (equivalently `npm run harness -- <command>`; the bare name
  `harness` is NOT on `PATH`). The runtime's own `main()` is the only dispatcher of the sixteen `case` arms.
- Gate: `npm run check:harness`. It is a two-node composition, run in this order:
  `node .harness/runtime/harness.mjs self-test`, then `node .harness/tests/compatibility.mjs`. `AGENTS.md` carries the
  totals and deliberately does NOT carry this invocation: it is operator procedure for a gate an ordinary agent never
  runs, and naming the machinery here keeps exactly one harness path in the always-loaded set.
- Coverage gap, recorded rather than hidden: the dispatcher has SIXTEEN `case` arms, and only SIX of them have a section
  in this manual — `evaluate`, `workspace`, `regress`, `census`, `contract` and `ledger`. The other TEN have none:
  `list`, `validate`, `show`, `taxonomy`, `report`, `modes`, `predicates`, `handoff`, `self-test` and `telemetry`. They
  are documented instead by their own `--help` screens (which every one of them prints, so `harness <command> --help` is
  the place to look), by the exit tables in [`docs/schemas.md`](docs/schemas.md) where they produce one, and by the
  assertion names in the gate output. This sentence is the disclosure; narrow it only as sections are added.
- Input contracts: `.harness/state/tasks/`
- Run streams and gate logs: `.harness/state/runs/`
- Durable ledgers: `.harness/state/ledgers/`
- Generated reports: `.harness/state/reports/`
- Generated telemetry: `.harness/state/telemetry/`
- Terminal-evaluation markers: `.harness/state/control/`
- Historical-workspace attestations: `.harness/state/workspaces/`
- Trial/census log: `.harness/state/regress-trials/`
- Worktrees: created OUTSIDE the repository, at the root named by the runtime, not under `.harness/state/`. The
  in-repository `.harness/state/worktrees/` path is LEGACY and nothing writes it: `remove-workspace.sh` only reports
  orphans left there, and `harness workspace prepare` refuses to run while any exist.

## Normative documentation

- [`docs/schemas.md`](docs/schemas.md) defines task contracts, run events, reports, telemetry, and verifier handoffs.
- [`docs/ledger.md`](docs/ledger.md) defines ledger loading, lifecycle, forensic access, and repair boundaries.
- [`docs/failure-taxonomy.md`](docs/failure-taxonomy.md) defines stable report failure categories.

Repository-wide policy is in [`AGENTS.md`](../AGENTS.md). The always-on project rules are in
[`.roo/rules/01-project-conventions.md`](../.roo/rules/01-project-conventions.md).

## Runtime commands

```bash
npm run harness -- list
npm run harness -- validate
npm run harness -- show <task-id>
npm run harness -- taxonomy
npm run harness -- contract init --task=<id>
npm run harness -- evaluate --task=<id> [options]
npm run harness -- evaluate --no-contract [options]
npm run harness -- evaluate --task=<id> --json
npm run harness -- regress --good=<ref> --target=<ref> --task=<id>
npm run harness -- census --from=<ref> --to=<ref> --step=<name> --task=<id>
npm run harness -- report
npm run harness -- modes
npm run harness -- handoff --template
npm run harness -- telemetry --scan
npm run harness -- ledger --help
```

A task contract is loaded from `.harness/state/tasks/<id>.json`. A run writes a JSONL event stream to
`.harness/state/runs/<run-id>.jsonl` and, when a gate executes, a sidecar `.gate.log` with the same run ID. Reports and
telemetry snapshots are generated under their matching `state/` homes unless an explicit output path is supplied.

## The decision surface — what an agent should read

`npm run check` is faster, cheaper to read and safer than this harness for the ordinary question "is my change green?".
The harness earns its keep on exactly one question `npm run check` cannot ask: **has this tree already been judged, over
what, in what environment — and what did those earlier judgements say?**

### `--json` — the versioned verdict

`evaluate --json` prints a `harness.evaluate.verdict/1` object on the last line. It is a **projection** of the run
stream, not a new record: the full stream is still written and deleting the verdict loses nothing.

```
{ "schema": "harness.evaluate.verdict/1", "verdict": "GATE_PASS", "scope": "FULL_GATE",
  "run_id": "…", "measured_at": "…", "judged_commit": "…",
  "judged_source_status_hash": "…", "commits_since_source": [], "declared_source_commit": "…",
  "gate_bearing": true, "steps_run": 5, "steps_total": 5, "gate_exit_code": 0, … }
```

**`GATE_PASS` is RESERVED for `scope: FULL_GATE`.** `scope` is mandatory, and a `SUBSET_GATE` pass, a `SINGLE_STEP` pass
and `--no-gate` are all `NOT_A_GATE_PASS`; a `GATE_FAIL` is still `GATE_FAIL` on every real-gate scope. A
`GATE_INCOMPATIBLE` run reports `gate_exit_code: null` — never `0` where no step ran. `gate_bearing` and `steps_total`
exist so a `check` run and a `check:fast` run are distinguishable in the record itself. The full vocabulary is in
[`docs/schemas.md`](docs/schemas.md).

**The HEAD of the verdict is an ordered list of NINE keys, and it is at the front of the object on purpose:** `schema`,
`verdict`, `scope`, `run_id`, `measured_at`, `judged_commit`, `declared_source_commit`, `judged_source_status_hash`,
`commits_since_source`. A run that judged a different commit than the contract declared is not a statement about that
baseline. `run_id` and `measured_at` are there so a stale saved verdict is distinguishable from a fresh one.
`judged_source_status_hash` and `commits_since_source` are there because `judged_commit` alone cannot distinguish a
clean tree from an uncommitted edit at the same commit, which is the whole test-manipulation surface. Those two disclose
a **difference, never a cause**: there is no `test_manipulation` field and no `confidence` field, and none is built.

**The head is an ORDER, not a byte window.** `verdictHeadByteFloor()` computes a **192**-byte minimum for a seven-key
head (a 112-byte empty prefix plus two 40-hex commits), which leaves 8 bytes for `verdict`, `scope`, `run_id` and
`measured_at` together — while `schema`'s own value alone is 28 bytes, so filling in `schema` puts the head at **218**.
No value assignment makes a nine-key head fit inside 200 bytes, and the byte positions are a consequence of the values
(a `--no-contract` run records `declared_source_commit: null` and moves them earlier). **No field is removed, reordered
or shortened to hit a byte count.** Asserted against a real run in `E28-04` and against the documents in group `I30`.

**The machine surface is the LAST line of stdout, and the only literal token.** The literal `harness.evaluate.verdict/1`
appears **exactly once** in the whole of stdout, on that line: `tail -1` and `grep -m1 'harness.evaluate.verdict/1'`
both get the right answer by construction. Inside fenced gate output the token is neutralised to
`harness.evaluate.verdict∕1` (U+2215), so gate output cannot forge the first grep hit. This is a **presentation
boundary, not an authenticity claim**: a same-principal writer still controls the gate, the contract, the evaluator and
the ledger.

### `prior_observations` — "maybe this failure is flaky", as data

Every run reports prior runs of **this exact judged state**, read from the streams already on disk with **zero extra
gate executions**: `{ caveat, caveat_code, n, distinct_gate_exit_codes, contradicted, by_step, … }`.

**`caveat` and `caveat_code` LEAD the object**, as siblings of the boolean, so the coupling residual is reachable
without reading prose. The human sentence is split too: at `n === 1` it says one run **cannot** agree or disagree with
anything.

It asserts **nothing** — no rate, no bound, no exchangeability assumption, and no guarantee of any kind. It says one
thing: those earlier runs of this state disagreed. That is enough for an agent not to conclude its change is broken on
the fifth consecutive red run, which is the entire value.

Its grouping key is `(judged_commit, contract_digest, judged_source_status_hash, gate, step)` from `run_started` —
**not** `run_finished`, which leaves two of those null on some records, and **not** `status_hash_pre`, which digests
`git status --porcelain` while `.harness/` is untracked and therefore changes on _every run this harness performs_.

### Reaching a contract at all

`.harness/state/tasks/` ships empty, so there are two ways in:

```bash
npm run harness -- contract init --task=<id>   # derive a minimal VALID contract from the current HEAD
npm run harness -- evaluate --no-contract      # run the gate with NO contract: contract_digest: null
```

`contract init` writes exactly the fields `validateTask` requires, so every contract valid before is valid after. **Its
seeded `acceptance` is a SEED, not a specification:** nobody wrote it, so a run against a seeded contract reports
`acceptance: unknown` and keeps reporting it until a human edits the file or passes `--acceptance`. The seed changes the
_shape_ of the contract, never the verdict.

A contractless run records `contract_digest: null` and `declared_source_commit: null` **explicitly** — never absent, and
never a digest of a synthetic task — and is refused with `--ledger`, because a ledger is durable state bound to a
contract.

### Unknown flags and stray positionals

An unrecognised flag is **refused by name with the allowlist printed**, at exit `2`, before any workspace, install or
gate. A stray positional (`evaluate COMPAT`) is refused the same way. A flag that was requested and not granted is a
silent capability loss, so it is never ignored.

### The `evaluate` exit table

Published in full by `npm run harness -- --help`, generated from the one constant the exit site is documented against.
Summary: `0` a passing gate **or** a passing single step (`SINGLE_STEP` — one step is not the gate); `1` a failure, an
`UNDEFINED` step, `--no-gate`, or a ledger status that is not `verified`; `2` a refusal before anything was measured;
`3` `gate_incompatible`, a **setup** failure and not an agent failure.

`regress` and `census` keep their own command-local sets, and `3` is never emitted by either. See
[`docs/schemas.md`](docs/schemas.md).

## Gate and tests

`npm run check:harness` runs:

1. `node .harness/runtime/harness.mjs self-test` — currently **491 assertions** across 40 invariant groups
2. `node .harness/tests/compatibility.mjs` — currently **224 cases**

These literals are **checked, not trusted**: the self-test's final assertion reads them out of this file and out of
`AGENTS.md` and compares them against the totals it is itself producing and against a count computed from the
compatibility suite's own case bodies. A number that goes stale here therefore turns the gate red rather than misleading
the next reader — which is the only way a number in prose stops rotting on its own.

Both counts are computed, never asserted against a fixed value. What the gate enforces is CONSISTENCY: the documented
figures are read out of this file and out of `AGENTS.md` and compared against the totals the run is actually producing,
so a number that rots here turns the gate red.

Monotonicity is a separate, WEAKER property, and it is enforced as a FLOOR rather than as a fixed value. Each measured
count is asserted to be **at or above** a floor recorded in the self-test (`ASSERTION_FLOOR`). The floor is a floor, not
a target: a cycle that adds assertions may raise the floor so the reduction is unrepeatable, and a cycle that
deliberately removes coverage may LOWER it — with a comment on the constant naming what the reduction cost and why it
was accepted. That is the whole mechanism. A reduction cannot be made invisible: the floor move is a diff like any
other, and the comment it carries is the written justification the reduction has to have. A deletion done to PRESERVE a
documented number — editing prose to match a shrunken suite rather than recording the shrink — is what the floor cannot
catch and what a reviewer is for.

The history is representable precisely because the floor is a floor: 422 → 486 across the suite's life, and a cycle's
deliberate deletions, are both ordinary moves of the floor rather than a rewrite of the assertion set. A declared case
label with no case body is a **FAILURE**, not a pass: the labels are seeded with a throwing body, so an unassigned label
cannot be counted as a green case (`SAN-09` asserts this, and asserts that every shipped label has a real body).

The self-test uses generated temporary repositories and state. It also captures a deterministic manifest of the complete
`.harness/runtime/` source tree before the complete test body and compares it after all test operations. The manifest
enumerates regular files in bytewise-sorted repository-relative path order, includes each file mode and lowercase
SHA-256 digest, rejects empty trees, symlinks, and unexpected entry types, and hashes a newline-terminated aggregate.
The check fails if any runtime source addition, deletion, mode change, or content change remains after the self-test.
Like any before/after comparison, it cannot observe a change that is restored byte-for-byte during the measured
interval.

The compatibility suite is implementation-independent: it creates disposable repositories and exercises the public CLI
contract. It also compares deterministic runtime-source manifests before and after representative invocations without
depending on Git tracking.

### Suite temporaries in the OS temp directory

Both suites write under the OS temp directory, and the mechanism that reclaims them is part of the shipped suite rather
than a house-keeping habit:

1. **`suiteTempDir` is the only way a fixture root is created**, and every root is removed in a `process.on('exit')`
   handler — covering a passing run, a case that threw, and a case interrupted in-process rather than surviving one.
2. **`sweepStaleSuiteTempDirs` reclaims what the exit handler cannot reach**: the roots of a SIGKILLed or power-lost
   run. It is deliberately conservative — only entries carrying one of this suite's own declared prefixes
   (`SUITE_TEMP_PREFIXES`), and only those untouched for longer than the stale window (**6 hours**), so a concurrent
   suite run's fixtures are never swept out from under it.

**The residue is bounded by the sweep, not by a per-run promise.** A `gate run` (`npm run check`, `evaluate`, `census`)
leaves nothing of its own. A compatibility run leaves a small number of one-to-two-byte marker files written by **child
gate processes**, each named by a hash only the writing child knows, so the parent cannot enumerate them from its own
state. They accumulate with run count inside the stale window and are reclaimed by a later run once they age past it.

What this does **not** do, stated because the limit belongs next to the mechanism: it does not reclaim a root still in
use, it cannot survive a SIGKILL by itself, and it touches nothing outside the prefixes above. A temporary directory is
not a security boundary, exactly as a worktree is not.

## Ledgers

Ledgers are ordinary local state and are never a trust, independence, authenticity, or non-repudiation claim. Readers
must use bounded parsing and exact identity checks documented in [`docs/ledger.md`](docs/ledger.md). A requested run ID,
the ledger filename, and the embedded `run_id` must agree. Forensic commands expose non-causal observations; they do not
promote a ledger to an operational state.

For a ledger-attached evaluation, exit 0 means the evaluator produced a terminal `verified` state in the attached
ledger. The durable ledger status is the protocol result for that local invocation. Missing, incompatible, or invalid
evidence must fail closed or remain explicitly unavailable rather than being inferred.

**`report`'s environment line is counted from the ledger files, and says so.** The join is on the **evaluation** run id
the newest `evaluations[]` entry names — `environments[].run_id` and `ledger.run_id` are different namespaces and are
never equal. The count is the number of ledger files on disk that hold a matching `environments[]` entry, and the
printed line names the join it used. A line that says it read a durable record it never read is a false statement on a
surface operators audit with; under-reporting is safer than mis-attribution, but silence about the join is not.

A gate-bearing, gate-compatible, ledger-attached run also appends one **commit-bound evaluation record** to
`ledger.evaluations[]` (additive, optional, non-causal — see [`docs/ledger.md`](docs/ledger.md) and
[`docs/schemas.md`](docs/schemas.md)). It names the commit that was judged, full 40-hex, observed before and after the
gate in the workspace the gate actually ran in, plus that directory, the tree's scope, the working-tree digest pair, the
resolved gate, the contract digest and the lockfile digest. It joins `verification[]` by `run_id` and changes no status,
no exit code and no classifier input. It is **not a reproduction recipe**: two equal observations are two samples, not a
proof, and it does not establish reproducibility, determinism, dependency fidelity or evaluator fidelity. Nothing here
changes the permanent class limitation below.

`harness ledger show` (human and `--json`) and `harness report` render the **observed** judged commit of the newest
evaluation beside the ledger's **declared** `source_commit`, each labelled, and say so when no judged commit was
recorded. `ledger.source_commit` is frozen at `ledger init` and is a diff base; default ledger selection is by
`updated_at`, not by commit, so the display states that too. This is display only: it changes no status, exit code,
enum, schema shape or classifier input, and a declared/observed mismatch is recorded, not blocking.

**The commit-blind selection disclosure is in EVERY display path, `--json` included.** One value renders both: the human
line and the JSON `selection` object carry the same `rule`, the same `commit_aware: false`, and a `candidates` count
computed from the same inventory the selection is made from — never a flattering constant.

**The ledger write is a compare-and-swap, not a lock.** `mutateLedger` publishes atomically (temp + `fsync` + rename),
so no torn file is ever read — but atomic publication is not durability of an _update_, and the mutation is a
read-modify-write: a slow passing run and a fast failing run on one ledger can both read the same bytes and both rename.
Each run captures the digest of the bytes it actually read, **before the gate runs**, and the write happens **if and
only if** the file on disk is still exactly those bytes. Anything else is a `LEDGER_WRITE_CONFLICT` **refusal** — never
a silent overwrite, and never a merge the operator did not ask for; the run exits 1 and the error says the
`ledger_status` in its own stream was not published. A **lock file was deliberately not chosen**: a lock must be cleaned
up on every path including a crash and a stale lock must be recoverable, or the wedge merely moves from "lost update" to
"permanently busy ledger". The CAS takes no lock, holds no lock and expires nothing.

**The two commit-bearing arrays are cross-checked against each other.** `evaluations[]` and `environments[]` are
appended by the same run under the same conditional, so their judged commits must agree: a cross-wired pair is flagged
as `evaluation_environment_commit_mismatch`, and an environment array naming no run the evaluation knows is
`environment_run_unbound`. This is defence in depth — it catches a **buggy writer** as readily as a tamper, and it
authenticates nothing: forging both arrays consistently remains the declared same-principal limitation.

## Historical workspaces (`harness workspace`)

```bash
node .harness/runtime/harness.mjs workspace prepare --commit=<ref> [--instance=<label>] [--offline] [--no-install] [--keep]
node .harness/runtime/harness.mjs workspace show [--commit=<ref>] [--instance=<label>] [--json]
node .harness/runtime/harness.mjs workspace list
node .harness/runtime/harness.mjs workspace remove --commit=<ref> [--instance=<label>] [--force]
node .harness/runtime/harness.mjs workspace prune [--stale-after=2h] [--force]
```

`prepare` resolves the ref to a full 40-hex commit, creates a **detached linked worktree at a root OUTSIDE the
repository**, and installs **that commit's own lockfile** with `npm ci` into a real directory. It writes a durable
attestation under `.harness/state/workspaces/<key>.<instance>.json` (operator state, gitignored, never a ledger) and
prints the commit, the root and the environment summary.

**No code path in this repository creates a `node_modules` symlink.** `npm ci` **destroys the target** of a symlinked
`node_modules` — it removes the link and deletes the victim's entire contents. `assertNoSymlinkedNodeModules` refuses
one it finds rather than passing it to npm. `prepare-workspace.sh` survives only as a delegating wrapper that exits 2
and points here.

`remove-workspace.sh` is deprecated on the same terms, with one job left: it no longer removes anything, and reports any
worktree still sitting at the legacy in-repository `.harness/state/worktrees/` path instead. Removal is
`harness workspace remove` / `harness workspace prune`, which reclaim and report bytes and exit NON-ZERO when any
removal failed — cleanup failure previously had no observable signal at all. `harness workspace prepare` refuses to
prepare while any legacy orphan exists, because silently adopting a symlink-contaminated worktree is the one migration
behaviour that could reintroduce the defect invisibly.

Because the root is derived from operator-controlled variables (`HARNESS_WORKTREE_ROOT`, then `XDG_CACHE_HOME`, then
`HOME`), "outside the repository" is a **policy, not a guarantee** — and an out-of-repo root can still inherit
`$HOME/node_modules` through the same upward module resolution. So the guarantee is measured, not assumed: a mechanical
**ancestor scan** `lstat`s a `node_modules` child at every existing ancestor of the root and refuses if one is there.
The root is also refused if it is or is contained by `REPO_ROOT`, if any path component is a symlink, if it is not
canonical, and if the created directory does not report `judged_commit_scope === 'linked_worktree_of_this_repo'`
(decided by the same `resolveJudgedScope` the evaluation record uses — not re-derived).

Two pre-flight refusals happen **before any process is spawned and before any directory is created**: a commit with no
`package-lock.json`, and a `lockfileVersion` outside the set the probed npm supports (npm ≥ 7 accepts v1 and v2
**silently**, so an out-of-set version is a success-shaped wrong answer). Both can be overridden only by an explicit
operator flag, and the override is recorded as a bounded deviation.

**The constructed environment.** `npm ci` and every gate step are spawned with an environment the harness builds and
digests, not the operator's shell inherited wholesale. `NODE_PATH`/`NODE_OPTIONS` can silently supply a module the
workspace does not have, so a prepare **refuses** them by name (`--accept-inherited-env=NODE_PATH` records the
acceptance as a deviation) and the gate child has them **removed and recorded**; every `npm_config_*`/`NPM_CONFIG_*` is
dropped and proxy variables are dropped and recorded by name. Values are never recorded — only a digest and a count. The
install runs with `HUSKY=0` because this repository's root `package.json` runs `prepare: husky`, which writes
`core.hooksPath` into the **primary** repository's shared `.git/config`; that file is snapshotted before and after and a
change is a hard error.

**The channel that is NOT closed: an npm config FILE.** Dropping every `npm_config_*` / `NPM_CONFIG_*` **variable**
(including `NPM_CONFIG_USERCONFIG`) does not stop npm re-deriving `$HOME/.npmrc` from `HOME`, which passes through
untouched — so a hostile user npmrc can still redirect the registry of a run recorded as `gate_env_policy: "sanitised"`,
`deviation: null`. In other words, a npm config file is a channel the environment sanitisation does not close. This is a
RECORDED LIMIT, not a solved problem. What is closed is the observability half: every environment record carries
`npm_config_files` — the resolved user and global config paths, their digests, whether npm would derive the user one
from `HOME` or was pointed elsewhere, and the registry npm actually resolved (asked only when a config file is present,
and with the same child environment the install and the gate received). **Values are never recorded: only a digest and a
path.** Closing the channel would mean refusing to run npm at all for any operator who has an npmrc, which is a
different product decision; the guarantee here is only that the run is no longer silent about it.

`--npm-cache=<dir>` / `HARNESS_NPM_CACHE` is a path input like the worktree root, and gets the same class of placement
refusal: a cache **inside the repository** is refused (`NPM_CACHE_PLACEMENT_REFUSED`, exit 2) before anything is spawned
or created, because a cache under the repository is untracked noise that `git status --porcelain` observes — which is
exactly the signal a `tree_moved` decision reads.

**Exit codes are command-local and are never evaluate exit codes:** `0` prepared or reused, `2` usage/refusal, `5`
environment failure (install or validation). An install failure is a **pre-evaluation event**: it produces no run, no
`evaluations[]` entry, no `verification[]` entry, no ledger status, and never a `test_failure` category. The
`evaluations[]`-style gate protocol is untouched.

**Reuse** requires the workspace key to match, the attestation to be `usable`, `git rev-parse HEAD` to re-read as the
same 40-hex, the topology re-check to pass, `installed_state_digest` to be re-verified, **and a fresh
`installed_tree_fingerprint` walk of the installed tree to match the attestation**. The five metadata conditions read no
bytes of the installed tree, so a truncated or hand-modified `node_modules` would otherwise satisfy all of them — and
re-verifying `installed_state_digest` alone still misses an **in-place content edit**, because that digest is npm's
_account_ of the tree and an edit leaves it byte-identical. The key covers the commit, the lockfile bytes, the full node
version, the full package-manager version, the platform, the effective `.npmrc`, the `npm_config_*` subset **and the
fingerprint tier**; each invocation gets its own **instance** directory, so two sides of a comparison at the same commit
cannot collide destructively.

**`--fingerprint=metadata|content`** picks the walk tier:

- `metadata` — path + type + size + mtime + ctime + mode — cannot be fooled by an ordinary process, because `ctime` is
  unforgeable.
- `content` — path + type + SHA-256 of every byte — depends on no filesystem timestamp semantics at all.

Measured costs are published next to the field in [`.harness/docs/schemas.md`](docs/schemas.md). Reuse **fails closed**
if no tier can be computed, and the tier's own "what this cannot see" sentence travels into the record.

**Gate output is fenced and prefixed; it is never a field of the harness's report.** The gate's tail is wrapped in an
explicit `--- begin … --- end` block naming the step it came from **and** every line inside it is prefixed with `|`, so
a forged `mechanically_verified: yes` renders as `| mechanically_verified: yes` — not a field line to any parser, human
or machine. The `regress` JSON artifact was already safe (it parses, and forged text survives only as an escaped string
value); this is the terminal surface only.

Interpreting a `file:`-based result: **a `file:` directory dependency installs as a symlink**, so both npm's digest and
the tree walk record the **link** and not the target's bytes; a `file:`-tarball dependency extracts to real files and is
hashed in full.

**Removal targets are re-derived, and the recorded `directory` is only cross-checked.** Two independent conditions hold
for `workspace remove` and `workspace prune`:

1. **CONTAINMENT** — the target's realpath must be inside the **resolved worktree root**, not its own parent. This is
   the security property and **nothing waives it**: not `--force`, not a matching key, not a registered worktree. A path
   outside the root is refused in every mode.
2. **IDENTITY** — the path is re-derived from `workspace_key` + `workspace_instance` under that same root, exactly as
   `prepare` derives it, and the recorded `directory` must resolve to the same realpath. `--force` waives this one only,
   because it is the shipped way to reclaim a directory under the root that this program did not create and git does not
   recognise.

**`prepare` BUILDS the workspace the gate needs — and why that is not optional.** A historical predicate can be
**constant-red**: a commit whose workspace lacks a build product its own gate declares makes every step fail for a
reason that is not about the commit's code. `shared/package.json` resolves only through the gitignored `./dist`,
`shared/` declares no `prepare` script, and nothing in a bare worktree ever built it. A constant-red predicate carries
no localisation information at all. `prepare` therefore runs **a historical build step** in the worktree, under the same
constructed child environment as the install, and:

- the command is **derived from the judged commit's own manifests** (never from the contract, never from the primary
  checkout), with a stated, versioned selection rule; the packages it rejects are recorded with the reason;
- the outcome is recorded exactly like the install's, and a **build failure is `unusable` with exit `5`** — never
  "usable, but the gate will fail for an unrecorded reason";
- `--no-build` disables it (recorded as a deviation) and `--build-command=<argv>` supplies it explicitly (recorded as a
  **declared** input; the harness spawns an argv, never a shell string, so a shell metacharacter is refused). Supplying
  both is refused.

**A build executes historical code, and it has no neutraliser.** The install runs with `HUSKY=0` precisely so npm's only
lifecycle script is neutralised; `npm run build` is a strictly larger class of script, and nothing equivalent
neutralises it. `historical_build_executed_arbitrary_scripts` is therefore permanently `null` with a basis saying so,
and never `true`. **A worktree is not a security boundary** — that code ran with the operator's privileges on the
operator's filesystem — and **historical reproducibility is not result authenticity**; a same-principal writer still
controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger.

**`build_state` records the deciding bytes, which are in the SOURCE tree.** The installed-tree fingerprint digests
`node_modules` and `status_hash` is a digest of `git status` **without** `--ignored`, so the gitignored build outputs
were invisible to every field. The observation is a content-tier digest over the planned packages' build-output
directories plus the **names** git reports as ignored for the worktree — one honest observation that covers
`shared/dist/`, `server/dist/`, `ui/dist/`, `ui/.angular/` and `ui/public/themes/manifest.json` without a field per
artefact. It is an **observation of bytes, not a content pin**: it cannot detect a build product outside the planned
entrypoint directories, a product the commit's own `.gitignore` does not list, any change to the **build** that produced
the bytes, or anything about the primary checkout. It is **names only** for ignored paths: a gitignored secrets file
such as `server/.dev.vars` is named because git names it, and its contents are never opened, hashed, digested or
recorded.

**Reuse re-verifies the build state, and fails closed on it.** It **rebuilds** when the bytes changed, and is
**refused** when the state cannot be observed at all — with its own refusal name, because "changed" and "cannot be
observed" are different facts.

**The installed-tree walk has an explicit, recorded exclusion set.** The walk root is `<workspace>/node_modules` and a
**gate run writes inside it** (a real checkout acquires `node_modules/.vite/vitest` and `node_modules/.cache/wrangler`).
A measured consequence: exact cold-install reproducibility is an **install-only** property, so a workspace that had run
the gate once would otherwise be refused on the next `prepare`. The declared set is exactly `[".vite", ".cache"]`,
recorded in `installed_tree_fingerprint_exclusions` with its version and what was actually excluded, and the cost is
stated in the recorded limitation string: every byte under those paths is UNATTESTED for the lifetime of that workspace.
The set is not a pattern and not a prefix list, so a sibling entry such as `vite-utils` is still attested, a tool that
writes its cache anywhere else is caught, and a genuine in-place tamper inside `node_modules` still forces a rebuild.

**A worktree directory deleted out of band is recoverable through the shipped path.** Once a registered worktree's
directory is absent, `git worktree add` refuses and a reclaim that requires a resolvable path can never fire. `prepare`,
`remove` and `prune` run `git worktree prune` when the target path is absent — exactly the state, and exactly the
recovery git itself names — so the instance recovers with no hand-editing.

## Two-commit comparison (`harness regress`)

```bash
node .harness/runtime/harness.mjs regress --good=<ref> --target=<ref> --task=<id> [--gate=<name>] [--keep]
                                         [--confirm-disagreement] [--gate-env=sanitised|inherited]
                                         [--json] [--out=<absolute-new-path>]
```

`regress` compares **two named commits**. It is not a verdict machine, not a search, and **not a bisect**. Each side
goes through the **same** path as everything else — `workspace prepare` with an instance label that is unique **per
invocation** (so two sides can never share a directory, and two concurrent comparisons of the same pair can never fight
over the same one), then `evaluate` at that worktree — so the ordinary gate, the run stream, the acceptance machinery
and the environment record are used unchanged rather than reimplemented. A side is identified by the run `regress`
itself just performed and by the **observed** `judged_commit` that run recorded: never by directory name, run ordering,
`updated_at`, or the contract's declared `source_commit`.

**It is read-mostly and non-causal with respect to LEDGER terminal state.** It attaches no ledger, appends no
`verification[]`/`evaluations[]`/`environments[]` entry, and sets no status, so it **enters no ledger-derived
denominator**. It is **not** invisible in `report`: each side is an ordinary gate-bearing `evaluate` run and **is**
counted there. `report` discloses exactly how many of its runs came from a comparison under `comparison_sourced_runs`
(printed and in the JSON), and **every existing denominator is left exactly as it was** — excluding comparison runs
would silently redefine what `report` has always meant. Its verdict is a printed and recorded observation, not a task
verdict. Two runs over the same durable inputs give the same verdict.

### The four side states

| State          | Meaning                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`         | the gate ran to completion, every step exited 0                                                                                                                                                                                                                                                                                 |
| `FAIL`         | the gate ran to completion and at least one step exited non-zero                                                                                                                                                                                                                                                                |
| `INCONCLUSIVE` | the side **was measured** but the measurement cannot decide: a refused/unusable workspace, a missing environment record, the tree moving during the run, a resolver probe escaping the workspace, an observed commit that is not the requested one, a differing contract digest or gate, or an unresolved mechanical acceptance |
| `ERROR`        | a **harness/operational** failure: a command could not be run to completion                                                                                                                                                                                                                                                     |

`ERROR` is a statement about the **tool**; `INCONCLUSIVE` is a statement about the **evaluated state**. `INCONCLUSIVE`
is **neither good nor bad**: it is never counted as a pass, never as a fail, and never resolved by preferring the side
that looks better.

### The verdicts

`no_regression` (both PASS) · `regression` (PASS → FAIL, printing the failing step and **both observed commits**) ·
`already_failing` (both FAIL — a **pre-existing** failure, deliberately **not** laundered into a regression finding) ·
`improved` (FAIL → PASS, said so honestly) · `cannot_compare` (either side undecidable, naming which and why; **no
regression statement is printed in any form**). `--good` and `--target` naming the same commit is refused as
`not_a_comparison` rather than pretending to have compared two things.

**Exit codes are command-local and are never evaluate exit codes:** `0` no finding · `1` a finding · `2` usage/refused ·
`4` a side is `ERROR` · `5` **no direction may be printed** · `6` a removal was refused. **`3` is never emitted** — it
is evaluate's `gate_incompatible`, and this command never runs a gate of its own.

**`5` covers BOTH** — two situations, and the printed label names both. It is reached when a side was measured but is
undecidable (a side `INCONCLUSIVE` — and `INCONCLUSIVE != PASS != FAIL`), **and** when a run is refused before any
verdict was derived at all — today only the trial-log byte bound, which is a command-local **environment** failure and
not a statement about either commit. They share a code because they agree on everything a caller acts on:
`verdict: cannot_compare`, no direction, neither side named as the winner; they differ only in **why**, and the refusal
line prints the reason beside the number. The printed `exit:` line is generated from the single definition
`REGRESS_EXIT_FIVE_BASIS` in [`runtime/harness.mjs`](runtime/harness.mjs), so it cannot drift from the manual. The
`regress` set is `0 1 2 4 5 6` with `3` never emitted, and widening a command-local protocol to fix a wording problem
gives the wording more places to rot.

**The printed `exit:` is always the process exit.** The **exit precedence** rule is: **a finding outranks a refused
cleanup.** A finding is a statement about the code; a refused removal is a statement about a directory this process
tried to delete, and substituting the second for the first would let a permission problem silently demote a real
regression. So a refused cleanup **raises only a no-finding `0` to `6`**, and is otherwise **disclosed beside** the
comparison's own code — it never replaces `4` or `5`, because an undecidable side is a statement about the evaluated
state and must not be hidden behind a directory. The rule is printed in the report and recorded in the artifact as
`exit_precedence`, and a reader can never see `exit: 5` while the shell returns 6.

Every side prints its environment record and the two are shown side by side: `judged_commit` (and the post-gate
`observed2`), `dependency_provisioning`, `installed_state_digest` (with its source), `node_modules_scope`, package
manager, node, platform, `env.vars_digest`, `lockfile_digest`, `contract_digest`, and the `status_hash_pre`/`post` pair.
**A difference there is a DISCLOSURE, never a verdict** — the two sides are supposed to differ. `gate_definition_sha256`
is printed for context and is deliberately **not** used in any comparison: it is a process-level constant that can never
differ.

**A side is bound to a commit by BOTH of its judged-commit samples.** `observed_judged_commit` is the pre-gate sample,
`observed_judged_commit_post` the post-gate one; both travel with the side, the printed line and the artifact, and **any
disagreement between them — or either of them naming a commit other than the requested one — makes the side
`INCONCLUSIVE` and the comparison `cannot_compare`**. This is load-bearing, not belt-and-braces: a gate that runs
`git checkout` mid-step leaves a **clean** worktree, so the pre-sample alone would attribute the result to a commit the
gate never ran against, and the status digest below cannot see it at all.

**`status_hash` is a digest of `git status --porcelain`, NOT a tree identity.** It is a working-tree **delta** digest: a
**commit change on a clean tree leaves it byte-identical**, because `git status` prints nothing either way. It also
moves for a regenerated untracked build product, so a `tree_moved` decision can be degraded by a build artefact on
either side of a commit boundary. Movement is therefore decided by the two judged-commit samples **first**; the digest
is a second, weaker signal, and this paragraph is repeated in the artifact as `status_hash_scope` and in
[`docs/schemas.md`](docs/schemas.md).

`--confirm-disagreement` is **opt-in and non-authoritative**: it re-runs the disagreeing side's failing step **once**
under the **same environment policy the comparison ran under** (read from that side's own record, not from the flag),
reports **both** observations, and never flips a verdict by asserting a new direction. **A single observation — with or
without the re-run — cannot distinguish a flaky predicate from a real difference**; that is a known limitation, not a
fix, and it is why every verdict is printed with its basis: `verdict: … [single observation per side]` and
`basis: single_observation — …`.

**A confirmation may REFUSE a direction, never assert one.** If the second observation **contradicts** the first, the
direction is **withdrawn** to `cannot_compare` (`exit 5`) with a printed reason and a `withdrawn:` line — it is not
replaced by the opposite direction. A program that has already observed a contradiction and still prints a finding is
laundering in the same class this comparison exists to remove. When the second observation **agrees**, the decision is
byte-identical, so a deterministic predicate behaves exactly as it always did.

### What each side's gate actually ran (`gate_execution_digest`)

Each side digests the **resolved gate definition** this process will execute, together with **the judged commit's own
definitions of the scripts that gate invokes**, read from the manifests **inside the judged workspace** (never from the
contract, never from the primary checkout). A difference is a **prominent** disclosure: it gets its own block inside the
comparison, above the routine environment table, and it is attached to the verdict as `verdict_disclosures`.

What this exists for: a commit that replaces the gate's own `test` script with something that always exits 0 — deleting
the very assertion that was failing — would otherwise be reported as `improved` while the application is still broken,
and the **lockfile digest is byte-identical** across that pair, so nothing else in the record could see it.

**The residual limit, stated plainly:** a gate whose **behaviour** changes without its **script text** changing is still
invisible to this digest. It records _what_ each side ran, never _why_ it produced the exit code it did. That is a known
limitation, not a solved problem.

The artifact is written under `.harness/state/reports/` with the exclusive-creation discipline, is **additive**, and is
**read by no decision path**.

### Recorded NO-GO: automatic `git bisect`

`git bisect` is **not implemented** — no command, no flag, no stub, and none is planned. The reasons:

- A project-wide gate predicate is **not monotone** — a break is later fixed, so "all descendants of a bad commit are
  bad" is false.
- **Git has no representation for a flaky predicate** (`0` good, `1–127` bad, `125` skip). Mapping `INCONCLUSIVE` onto
  `125` makes git **skip exactly the undecidable commits**, suppressing the very commit that would explain the result.
- There is **no `pick_winner`** when one side is undecidable.
- **The `check` gate is UNDEFINED over most of this repository's own history.** Over the **143 commits reachable from
  `HEAD`**, **86 (60.1 %)** do not declare a `ui` `typecheck` script at all, so a whole-project `check` gate cannot be
  defined from their own manifests. The block is **contiguous and older** — its boundary is **`81165e6`**, the oldest
  commit that _does_ declare the script.

> **Basis (reproduce it, do not trust it).** For each of the 143 commits, read `<commit>:ui/package.json` and test
> `scripts.typecheck` for a string. The 86 without it are `false` for every commit from `e5ece52` (the newest of them)
> to `1e06f13` (the oldest), with no interruption. `git log --format=%H -n 143` supplies the window; the script is four
> lines and the figure is recomputed, never remembered.

**Those 86 commits are UNDEFINED, not red.** No gate was run there, nothing failed, and nothing is attributed to those
commits. "Undefined" is not a weaker "fail" — a failure is a measurement, and there is no measurement. A bisect over
this history would therefore face git's own `125` (**untestable**) over most of its range, and git's answer to a `125`
is to _skip the commit and keep narrowing_ — which drops precisely the commits whose undefinedness explains the missing
evidence, biases the search late in a fixed direction, and reports a boundary it did not examine.

**Automatic boundary search is not implemented: there is no command, no flag and no stub, and this is the shipped
product decision.** The falsifier below is the operational statement of what would have to change for that decision to
be revisited: **a skip-suppresses-the-culprit mapping** that shows the bracketing interval for every reported culprit
and enumerates every `INCONCLUSIVE` commit inside it rather than skipping it — any run whose interval contains an
unexamined commit is not a report. It must arrive together with a **flake study** with `0` verdict flips in `N` repeated
runs at **≥ 3 commits**, `N` stated, and with **monotonicity evidence** on a **≥ 50-commit** window (or a per-step
predicate with the same evidence). The undefinedness reason is deliberately **not** on that list: it is a property of
_this repository's manifests_ rather than of the predicate, and it is discharged by the script appearing in the older
history — not by any amount of evidence about flakiness.

### Repeated evaluation: `regress --repeat=N`

`--repeat=N` runs **N independent trials per side**. Each trial is a complete `workspace prepare` + `evaluate` with its
own workspace instance, its own run id and its own provenance, and **every trial is preserved** — in the artifact and in
an append-only trial log. `N = 1` is the default and reproduces this command's behaviour exactly.

#### Order-aware trials: the first position ALTERNATES

**The rule.** Within a trial block the **first position alternates between the sides**: trial 0 is `good -> target`,
trial 1 is `target -> good`, and so on (`regressInterleavedSchedule`, recorded by `regressExecutionOrder` in
`repeat.execution_order`). The permanent `good`-then-`target` alignment exists in no trial, so an order-coupled defect
has to disagree with **itself**, which is exactly what the contradiction rule exists to catch. No vote was introduced,
no threshold was relaxed, and the classification code is unchanged.

| field in `repeat.execution_order`           | what it is                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `scheme`                                    | `single_block` at `N = 1`, `interleaved_rotated` at `N > 1`                                            |
| `rotate_first_position`                     | `false` at `N = 1` — one trial has no second position to alternate into                                |
| `schedule` / `position_by_trial`            | the measured order per trial, and the position each side occupied (`0` = ran first)                    |
| `schedule_digest`                           | a digest of the schedule, so two runs can be compared                                                  |
| `legacy_order_replaced` / `is_legacy_order` | the **negative control**: the design this replaced, named so a reader can check the design is _not_ it |
| `basis` / `residual`                        | what the interleaving does, and what it does **not** cover                                             |

`repeat.position_conditional` — `regressPositionConditionalStates` — groups each side's trials by the position that side
occupied and is a **disclosure, never a classification input** (`classification_input: false`). It is refused as an
input because a position-conditional split is a strict subset of the within-side disagreement the contradiction rule
already catches — it would add a name, not coverage.

**`N = 1` is unchanged, and that is a checkable field rather than a promise.** The schedule at `N = 1` is the single
block `['good', 'target']` — byte-for-byte the pre-`--repeat` order — and the order block is printed only at `N > 1`.
The verdict, the exit code and the terminal output at `N = 1` are unchanged.

**WHAT THE INTERLEAVING DOES NOT COVER.** It permutes the **position** a side occupied in its block; it does not permute
**time**. A defect whose outcome is a function of something the rotation leaves invariant — the **trial index** (its
parity), the absolute order of gate executions across the whole session, a one-shot resource consumed once per session
wherever it sits in a block — stays perfectly consistent across **both** sides in every trial, and this program **cannot
distinguish it from a real difference**. No further signal is added as a classifier, and the reason is the honest one:
**any schedule is periodic**, so a defect periodic with the schedule's period is aligned with it by construction.
Randomising the order would break that alignment while making the artifact impossible to re-derive, and it would still
be a heuristic — it manufactures apparent exchangeability rather than establishing it, which is the one thing this
programme refuses to do. The residual is recorded, not engineered away.

**The classification is the contradiction rule, and a vote is never used.** ANY disagreement among the trials makes the
side `INCONCLUSIVE`. Not a majority, not a best-of, not the last, not the most common. At a flip rate near 0.5 a
majority vote is wrong **exactly half the time for every N**, so repetition cannot rescue it. A trial that is `ERROR` or
itself `INCONCLUSIVE` is never averaged away by its siblings agreeing.

### Per-step evaluation: `evaluate --step=<name>`

The gate loop is **fail-fast with a `break`**, which is right for a conjunction and wrong for a census: a `check` gate
that fails at `test:server` leaves `test:ui` and the build steps **unmeasured**, and per-step history is then
unrecoverable from the record.

`--step=<name>` runs **one named step of a gate, independently, with no fail-fast**, and produces the **same**
run-stream events and provenance the gate loop produces. The flag **selects which steps the existing loop runs** — one
gate loop, one `runStep`, one `verification_started` / `verification_finished` pair, one provenance format, before and
after — so the CLI does not grow a second implementation of a provenance path.

| where                                                                                      | the field / function                                                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `evaluate`, `regress`, `workspace prepare` flag                                            | `--step=<name>`                                                                               |
| `resolveStepFlag(flags, gateName)`                                                         | validates the flag; refuses a bare `--step`, and `--step` together with `--no-gate`           |
| `assertGateStepExists(gateName, stepName)`                                                 | refuses an unknown step **by name**, before any workspace is prepared or any install is spent |
| `resolveStepScope(gateName, stepName, workspacePath)`                                      | the two states: `runnable` or `UNDEFINED`                                                     |
| `step_scope` (run events, `run_finished`, `sides.<role>`, artifact, workspace attestation) | the scope and the per-step answer                                                             |
| `STEP_SCOPE_UNDEFINED_BASIS`                                                               | what `UNDEFINED` means, stated where it is enforced                                           |
| `STEP_SCOPE_FAIL_FAST_BASIS`                                                               | why there is nothing a fail-fast could have skipped                                           |
| `STEP_SCOPE_LEDGER_EFFECT`                                                                 | what a per-step run deliberately does **not** do                                              |

**`UNDEFINED` IS A DISTINCT OUTCOME AND IS NEVER A `FAIL`.** A step whose npm script the **judged commit's own
manifests** do not declare has **no command to run**: `npm run <script>` against such a workspace exits non-zero, and
reporting that exit code as a step failure would manufacture a `FAIL` out of the _absence of a declaration_. So nothing
is spawned, `step_scope.state` is `UNDEFINED`, `gate_exit_code` is an explicit **`null`** (never `0`, which is the one
number that silently reads as a pass), no `verification_started` / `verification_finished` pair is emitted, and a side
measured that way is **`INCONCLUSIVE`** — never `PASS`, never `FAIL`, never a direction. This matters at exactly the
scale the compatibility census found: **86 of the 143 commits** reachable from `HEAD` declare no `ui typecheck` script,
so a whole `check` gate is `UNDEFINED` over **60.1 %** of this repository's own history — and those commits are
**UNDEFINED, not red**.

**Composition, with no second anything.** `--step` reaches `workspace prepare` as well as `evaluate`, so a per-step run
happens inside a fully attested historical workspace (install, lockfile digest, installed-state digest, tree fingerprint
and build state all as usual), and the workspace's _whole-gate_ refusal does not answer a _per-step_ question. It
composes with `regress` and with `regress --repeat` — each trial is one more per-step run, classified by the same
`classifyRegressSide`, with the order rotation and the contradiction rule unchanged. It adds **no second ledger, no
second workspace implementation and no second provenance format**: a per-step run does not update the attached ledger at
all (`STEP_SCOPE_LEDGER_EFFECT`), and the whole-gate answer is still recorded beside the per-step one as a disclosure.

**A per-step run derives no terminal state, and the exit protocol is unchanged.** Exit `0` still means "this run
mechanically verified the **gate**"; a per-step run therefore **never** returns `0`, whatever its one step did, and **no
new exit code was minted** for this mode. `mechanically_verified` is `false` even when the step exits `0`, because a
step says nothing about the steps that were not run.

**The bound is printed with the assumption it rests on, and its `exact` label is CHECKED rather than asserted.** `N`,
`k`, and the **exact** one-sided binomial upper limit (`k = 0`: `1 - alpha^(1/N)`; `k >= 1`: the Clopper–Pearson exact
interval), together with the standing line `exchangeability: assumed, unverified` and what breaks it (a positively
correlated defect — a warm/cold cache, a session-scoped resource, a first-run-only failure — or load). Every record
re-evaluates the binomial tail **at the value it is about to publish** and reports the residual; `exact: false` ships a
reason, and a value it cannot corroborate is published as `null` rather than as a number. The evaluation is seeded in
log space, and the self-test sweeps the published range against an **independent exact-rational (`BigInt`) reference**
and requires every published bound to solve its printed equation. The words "stable", "confirmed" and "reproducible"
appear nowhere in the aggregate output: they are what turns a number into a guarantee.

**The anti-conservative flag is arithmetic, and it says so.** It fires when observing a disagreement made the number
_tighter_ than the zero-flip bound for the same `N`. At `k = 1` the exact limit is already about `0.05 / N`, so
**essentially every ordinary disagreement fires it, including a perfectly exchangeable `p = 0.01` observation**. The
record therefore carries `anti_conservative_is_evidence_of_defect: false` and states that the flag is the arithmetic of
`k >= 1`, not a measurement.

**Repetition takes no vote, and repetition cannot rescue a wrong direction.** Measured on a four-commit fixture (`A`
PASS, `B` flaky p ≈ 0.2, `C` PASS, `D` FAIL; truth = `C`), **40/40** independent real bisects produced a **wrong
boundary 40/40** times. A commit that failed only the first run of a session agreed **58/59** times in one block — a
bound of **p ≤ 0.087 %**, fifty-seven times tighter than the **4.95 %** the same N certifies from zero flips — while
failing **9/9** in the condition a bisect step actually runs in, with a **byte-identical** workspace attestation.
Observing a single flip made the number look _more_ certain.

**`INCONCLUSIVE` is NON-RESOLVING, never skippable, and is not git's `125`.** `125` means "untestable — exclude this
commit and keep searching", which drops the very commit that would explain the disagreement and biases a search late in
a fixed direction. Here the same situation is a refusal that never skips, never narrows a search and never names the
other side the winner. `skippable: false` and `resolves_boundary: false` travel in every aggregate.

**A single observation cannot distinguish a flaky predicate from a real difference between two commits, and repetition
does not fix that.** `regress --repeat` stays non-causal with respect to LEDGER terminal state at every `N`: no ledger
is attached, nothing is appended, no status is set. An interrupted run loses no completed trial
(`--repeat-session=<token>` replays them and rewrites none). `git bisect` remains the recorded NO-GO above.

Full schema: [`docs/schemas.md`](docs/schemas.md).

#### What the trial log actually guarantees (and what it does not)

`--repeat-session=<token>` is **bound to one comparison**: the pair, the task, the gate and the environment policy.
Re-using a token against a different pair is **refused by name** (`REPLAY_SESSION_BINDING_MISMATCH`) rather than
answered with the wrong measurements.

A **replayed trial is re-derived, not believed**. The recorded `gate_exit_code` and `judged_commit` are re-read from the
run stream the trial names and the state is recomputed from them; a trial that cannot be re-derived is marked
`verified: false` with a named reason, and its side becomes **not classifiable** — agreeing sibling trials never average
it away and it can never produce a direction.

The log is a **per-entry digest chain** plus a separately published head recording the entry count, so an interior
rewrite, a removed or reordered row, and a **tail truncation** are all detected. `append_only: true` and
`rewritten: false` describe **this program's own writes** and are backed by that mechanism.

> **This is a detector, not a security control, and forging the bytes is not fixed.** A same-principal writer controls
> the trial log, the head file, the gate, the contract, the acceptance policy, the dependencies, the evaluator and the
> ledger, so the chain is a **truncation-or-rewrite detector for this program** — a smaller claim than authenticity.
> What is fixed is narrower: the harness no longer **asserts** properties it has not checked.

Two limits, named apart: `REPEAT_MAX_TRIALS` (299) is a **count** of trials per side, and the trial log's **size** limit
is a separate, enforced `REPEAT_TRIALS_LOG_MAX_BYTES` checked before every append. Concurrency on one session token is
**detected, not locked** — a duplicated trial index is refused (`DUPLICATE_TRIAL_INDEX`) instead of being silently
resolved by keeping the first entry. A worktree is not a security boundary, and historical reproducibility is not result
authenticity: both stand unchanged.

### What this is not

A worktree is not a security boundary, and historical reproducibility is not result authenticity. Stated again in the
form a reader is most likely to need it: **a worktree is not a security boundary**, and a `usable` attestation is not
authenticity evidence. The worktree is a place on a filesystem, the install executes a historical manifest's lifecycle
scripts with operator privileges, and "observed" in these records means _this local program looked_ — never that a lie
would require a writer. The environment record **cannot retroactively exonerate or condemn any run recorded before it**:
a run with no such record reads as "not recorded", which is a normal state, not an absence of evidence and not an
accusation.

**What a build does outside the worktree is observed, with its own blind spot named as data.** A build executes the
judged commit's own `build` string with the operator's privileges on the operator's filesystem. The workspace
attestation records a bounded pre/post comparison of the top-level **name** sets of three named roots (the worktree's
parent directory, the system temp directory, the home directory), with paths digested rather than printed, and the same
record carries `outside_worktree_writes_fully_observed: false` and an `unobserved_class` naming what is **not** seen: a
write inside a directory that already existed, a change to a file's contents, and any write to the unbounded remainder
of the filesystem.

This is a **detection and observability limit, not prevention**, and it is stated as such rather than as a mitigation.
`outside_worktree_write_detected: false` means "no top-level name changed in the three probed roots" — never "the build
wrote nothing outside the worktree". Nothing here confines a build, and a worktree is not a security boundary.

Two more limits in the same family, recorded for the same reason:

- **`installed_tree_fingerprint_excluded_entries`** quantifies what the walk exclusion leaves unattested.
  `installed_tree_fingerprint_entries_raw` is the pre-exclusion count and the two reconcile exactly
  (`raw - entries === excluded_entries`). The count is count-only: no file under an excluded path is opened, so
  quantifying the exclusion does not become an observation of the bytes it declines to attest.
- **`installed_tree_fingerprint_exclusions_version` is part of the workspace reuse key**, because the exclusion set
  changes what the digest _means_ while leaving its algorithm, tier and cost identical. A workspace verified under one
  exclusion set is verified under different rules, and reuse must not cross that boundary silently.

It also does not pin: a correct `npm ci` under npm 12 is not the same tree as under npm 9 (npm 12 blocks install scripts
by policy), and **no historical Node version is installed here** — the tree is a function of
`(lockfile bytes, npm version, node version, platform)` on _this_ host, not a replay of the environment the commit's
author had.

## History census (`harness census`)

`harness regress` answers one question about **two named commits**: did a difference appear between them.
`harness census` answers a different question about a **range**: what does the matrix over every commit in that range
look like, where are the failure regions, and which commits sit at the observed transitions.

```bash
node .harness/runtime/harness.mjs census --from=<ref> --to=<ref> --step=<name> --task=<id> \
  [--gate=<name>] [--keep] [--gate-env=sanitised|inherited] [--fingerprint=metadata|content] \
  [--json] [--out=<absolute-new-path>] [--census-session=<token>]
```

A census is a new **question**, never a new **implementation**. Every commit goes through the ordinary
`workspace prepare` and the ordinary `evaluate --step` path, so a matrix row carries exactly the provenance a comparison
side carries, and the durable per-commit row is the **existing** append-only trial log — one chain, one head, one
reader. There is no census ledger, no second workspace implementation and no second provenance format, and the command
changes **no ledger terminal state**.

**A project-wide gate predicate is not monotone**, and a census is the non-searching counterpart of the recorded
`git bisect` NO-GO rather than a replacement for it. The correct output of a history survey is **failure regions and
classified candidates**, and a tool that names one commit is wrong. `census` re-measures a range you name and publishes
its own numbers; that is the supported way to obtain a fresh figure.

**Output vocabulary.**

| term                      | meaning                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `matrix`                  | every commit as `PASS` \| `FAIL` \| `UNDEFINED` \| `INCONCLUSIVE` \| `ERROR`, with its full provenance |
| `failure_regions`         | each contiguous run of `FAIL` commits, with its 40-hex start and end commit and its length             |
| `observed_transitions`    | every adjacent `PASS→FAIL` and `FAIL→PASS`, with the evidence available at that boundary               |
| `reversals`               | the `FAIL→PASS` subset — a healed predicate, so the history is not a step function of the commit       |
| `candidates`              | the commit at each region's `PASS→FAIL` boundary, named **`candidate`**                                |
| `monotonicity`            | `MONOTONE` \| `NOT_MONOTONE` \| `UNDETERMINED`, scoped to `measured_range_only`                        |
| `refusal`                 | present whenever the range is non-monotone                                                             |
| `cascade` / `error_modes` | the classification rules, and the limits of the classification itself                                  |

**`UNDEFINED` is a distinct outcome and is never a `FAIL`.** A step the judged commit's own manifests do not declare
spawned **nothing**: no command, no exit code, an explicit `null`. Such a commit is **enumerated**, is
**non-resolving**, and never becomes a failure. This is named differently from git's `125` on purpose: git's `125` means
"exclude this commit and keep searching", which biases a search **late in a fixed direction**. Here nothing is excluded
and nothing keeps searching. When any commit in the range is `UNDEFINED` or `INCONCLUSIVE`, the verdict is
`UNDETERMINED` and **no verdict is printed in either direction**.

**The classification cascade** is five mechanical rules, **all** asked, none short-circuited: `TEST_EVOLUTION`,
`CROSS_PACKAGE_MIGRATION`, `CROSS_PACKAGE_COMPLETED`, `PREDICATE_DESIGN`, `SOURCE_CHANGE`. **More than one rule firing
is `INCONCLUSIVE`**, and so is any transition whose evidence could not be read. There is **no precedence among the rules
and no way to ask for one** — `rule` is `null` on a multi-firing rather than the first rule that fired.

The cascade classifies the **shape of the diff at an observed transition**. It is **not a cause, it does not apportion a
commit**, and it does not establish that the named mechanism is what moved the verdict. Its own error modes are recorded
as **data** on every classification, not as prose only:

- **`CONFOUNDED_CONFIG_AND_SOURCE`** — one commit rewrote the step's configuration _and_ its source; the two
  explanations **cannot be apportioned from a diff**, so the result is `INCONCLUSIVE` rather than a label.
- **`MIXED_TEST_AND_SOURCE_COMMIT`** — one commit touched tests _and_ source, so rule 1 cannot fire and the commit falls
  through to `SOURCE_CHANGE`, which reports a test rewrite as though it were a production change. This program
  **cannot** distinguish a fix that also adjusted its tests from a test edit that accompanied a real source change.
  `mixed_test_and_source_change: true` is on the record so the label alone never misleads.
- **`TEST_EDIT_MAY_MASK_A_REGRESSION`** — rule 1 fired on a `FAIL→PASS`, so the only thing that changed is what the
  predicate measures. A test-only change can heal a real regression, and a deliberately relaxed assertion **cannot** be
  told from a corrected one. `masks_a_regression_possible: true`, and a `TEST_EVOLUTION` label is explicitly **not** a
  statement that the code improved.
- **`PRODUCER_PACKAGE_UNRESOLVED`**, **`SIGNATURE_UNAVAILABLE`**, **`DIFF_UNAVAILABLE`** — a rule that **could not be
  asked**. An undecidable rule never silently not-fires: it is recorded in `undecidable`, which is distinct from
  `inapplicable` (a rule that was never in scope, such as `TEST_EVOLUTION` on a `lint` step).

**Monotonicity applies to the measured range only.** `monotonicity.scope` is `measured_range_only`, and the verdict is
decided in a fixed order: a reversal (or more than one disjoint region) ⇒ `NOT_MONOTONE`; otherwise an `UNDEFINED` /
`INCONCLUSIVE` / `ERROR` commit ⇒ `UNDETERMINED`; otherwise `MONOTONE`. A reversal is checked **first**, because a
reversal was observed inside the range and a hole elsewhere does not un-observe it. `MONOTONE` is **structurally
unreachable** while a reversal is present. A step that `PASSES` at every commit additionally reports
`carries_no_information: true` — it is monotone in the trivial sense and localises no boundary.

**A non-monotone range refuses a single boundary.** The output states that one is **not identified**, why, and what is
offered instead; `not_offered` names `first_bad_commit`, `midpoint_selection`, `narrowing` and `bisection` so a reader
does not go looking for them. A census is **not a search**: it enumerates exactly the commits `--from..--to` names,
reports every one of them, and never narrows, halves, samples, selects a midpoint, or proposes a next commit to measure.
An over-long range is **refused by name**; narrowing it is the operator's decision, not this program's.

**Interrupting and resuming.** `--census-session=<token>` names the append-only census log. Completed commits are
**replayed** from it, never re-run and never rewritten, and a real `SIGKILL` mid-range loses nothing. A token already
holding a **different** range, step, task or environment policy is **refused by name**, before any workspace exists.

**Command-local exit codes** (not `evaluate` exit codes; `3` is **never** emitted):

| code | meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | the range was enumerated in full and contains no failure region                                |
| `1`  | at least one failure **region** — a finding about a range, never a direction about one commit  |
| `2`  | usage / refusal, always before any workspace was prepared, installed, built or measured        |
| `4`  | at least one commit is `ERROR` — a statement about this program, not about the history         |
| `5`  | the verdict is `UNDETERMINED`: the range has a hole and carries no verdict in either direction |

Precedence is `4` outranks `5` outranks `1`, mirroring `compareRegressSides`. A refused removal is disclosed beside the
code and never demotes it. The printed exit **is** the process exit.

**Standing limitations, carried unchanged.** **A worktree is not a security boundary, and historical reproducibility is
not result authenticity.** A **same-principal writer** controls the gate, the contract, the acceptance policy, the
dependencies, the evaluator and the ledger, and no field in a census record proves a result authentic. A single
observation per commit cannot distinguish a flaky predicate from a real difference. A build executes historical code
with no neutraliser. `censusMonotonicity`, `censusRefusal`, `censusUnresolvedBlock`, `censusClassifyTransition`,
`CENSUS_CASCADE`, `CENSUS_ERROR_MODES` and the exit constants are the shipped names.

**Terminology is load-bearing.** A commit under comparison is a **candidate**; a comparison reports an **observed
transition** between two named commits; a **boundary** is a candidate at such a transition. **A transition is not a
cause, and a commit is never named as the responsible party** — a candidate can be the boundary and still be innocent,
which is precisely why a non-monotone history yields regions, candidates and a refusal rather than one named commit. The
fields are `candidate`, `region`, `transition_commit` and `boundary`; there is no `cause` field and no `responsible`
field to read instead.

## Terminal-evaluation control

```bash
node .harness/runtime/terminal-evaluation.mjs status
node .harness/runtime/terminal-evaluation.mjs disable
node .harness/runtime/terminal-evaluation.mjs enable
node .harness/runtime/terminal-evaluation.mjs evaluate --task=<id> [options]
```

The control marker is `.harness/state/control/terminal-evaluation.disabled`. This is an explicit operator switch, not a
security boundary.

## Permanent class limitation

> A persisted harness `verified` result is unauthenticated same-principal local qualification, not trust, independence,
> authenticity, or non-repudiation. A same-principal writer controls the gate, contract, acceptance policy, direct
> verifier input, dependencies, evaluator, and downstream consumer, and can still manufacture a fresh local `verified`
> result. The harness cannot authenticate the writer, prove which contract or gate was intended, prove the candidate
> stayed fixed, enforce an independent consumer boundary, or prevent evaluator rollback. A green result is only a
> supported local-program observation about bytes supplied to that program. Exit codes are reporting signals; the
> durable ledger is protocol authority only within the supported local protocol.

The harness has no environment isolation. Verifier separation is procedural and capability-bounded, and is
`never described as isolation`. An evaluator is not independent merely because a separate role or process exists.
Missing external observations are recorded as unavailable, never fabricated as zero or inferred from another source.

## Reporting verification

Report the actual command and outcome:

```text
STATUS: DONE
VERIFICATION:
  command: npm run check:harness
  result: PASS
```

A command that was not run must be reported as `NOT_RUN`; a failed command must be reported as `FAIL`.
