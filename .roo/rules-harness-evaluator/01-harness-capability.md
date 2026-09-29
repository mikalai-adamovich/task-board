# Harness capability — evaluation and measurement forensics

This file is a **procedure**, not a second copy of the machinery: every paragraph below says what to do or what a word
means, and links out. **The invocation prefix.** `harness` is **not on `PATH`** — a bare `harness evaluate --help` fails
with `command not found`. Every command below is `npm run harness -- <command>`, or
`node .harness/runtime/harness.mjs <command>`.

Whether an ordinary session loads a mode-scoped rules directory is a platform mechanism this repository does not verify,
and nothing below rests on it. The guarantee this repository can check is that `AGENTS.md` is in the layer-0 set on
every session and names this file's path and the `scope` rule, so an agent that never selects the `harness-evaluator`
mode is still routed here by a file it already has — because a verdict file can be handed to an ordinary agent by a
third party.

## 1. When this applies — and when it does not

**Applies when the question is about measurement, not about code:** a gate result that must be attributed to a specific
commit; "did this break somewhere in this range"; a verdict or claim whose `scope` is not `FULL_GATE`; a failure that
must be characterised rather than averaged away; a provenance, ledger or historical-workspace question.

**It does not apply to an ordinary feature, bugfix or refactor.** Those are `npm run check` and nothing else.

## 2. The standing limitations, first and un-softened

- **A claim is not verification.** `mechanically_verified: yes` reports what a program did, not that a project
  validates. Read `scope` before reading the exit code.
- **A persisted `verified` is unauthenticated local qualification** by the same principal that wrote it. Integrity is a
  _detective_ control: an unchanged artifact must be shown with a digest, never assumed.
- **A worktree is not a security boundary** — the same host account that runs the gate can write the contract, the
  dependencies, the evaluator and the ledger.
- **Historical reproducibility is not result authenticity.** Re-running a past state reproduces the observation, not the
  authenticity of the original judgement.
- **This surface is not a sandbox**, and a narrower tool surface is not a security boundary either.

## 3. The procedure

1. **Reach a contract** — `npm run harness -- contract init --task=<id>`, or `evaluate --no-contract` for an explicit
   `contract_digest: null`. Exits: `0` created or accepted · `2` refused before anything was measured. **`contract init`
   seeds `source_commit` from the current `HEAD`**, so a freshly initialised contract is not a baseline: the good ref is
   one you choose and record yourself.
2. **Build the workspace** — `npm run harness -- workspace prepare --commit=<ref>` derives its build command from the
   _judged commit's own_ manifests, never from the contract or the primary checkout. Exits: `0` prepared or reused · `2`
   usage or refusal · `5` unusable, meaning **the environment could not be produced** — a failed install or build, a
   lockfile that disappeared, a resolver negative control that resolved, or the primary checkout changing under the
   install. `5` is therefore not only a build failure; read the `validation problems:` block it prints. **Know what it
   costs before you run it:** it needs the npm registry (it performs a real `npm ci` against that commit's own lockfile,
   or `--offline`); the worktree lands **outside** the repository; the install mutates the **primary** repository's
   shared git metadata (this repository's `prepare: husky` writes `core.hooksPath` into the primary `.git/config`,
   snapshotted before and after, and a change is a hard error); and the gate child runs with a **sanitised**
   environment. Sanitising drops the `npm_config_*` / `NPM_CONFIG_*` **variables**, not an npm config **file**, so a
   hostile `$HOME/.npmrc` can still redirect the registry of a run recorded as `gate_env_policy: "sanitised"` — a
   recorded limit, not a solved problem. The rest, §"Historical workspaces", is in `.harness/README.md`.
3. **Measure** — `npm run harness -- evaluate --json` puts the versioned verdict on the LAST line of stdout. Exits: `0`
   a passing gate, or a passing single step (`SINGLE_STEP` is not the gate) · `1` a failure, an `UNDEFINED` step, or
   `--no-gate` · `2` a refusal before anything was measured · `3` `gate_incompatible`, a setup failure, not an agent
   failure. **It measures the working tree unless `--workspace=<path>` names a prepared workspace** — following this
   step literally otherwise measures the wrong tree. The `check` gate is five steps, read from the runtime's `GATES`
   constant: `lint`, `typecheck:shared+server`, `typecheck:ui`, `test:server`, `test:ui`.
4. **Compare two commits, or scan a range** — `npm run harness -- regress --good=<ref> --target=<ref> --task=<id>`, plus
   `--repeat=<n>` for independent trials. `npm run harness -- census --from=<ref> --to=<ref> --step=<name> --task=<id>`
   measures one step over every commit of a range. Both publish their OWN exit set and neither ever emits `3`.
   - `regress`: `0` no finding · `1` a finding · `2` refused before any workspace · `4` a side is `ERROR` · `5` a side
     is `INCONCLUSIVE`, or no verdict could be derived at all · `6` a refused removal (a finding `1` outranks it).
   - `census`: `0` no failure region · `1` at least one failure region · `2` refused · `4` a commit is `ERROR` · `5` the
     range is `UNDETERMINED`.

   A census is bounded by **cost, at 299 commits**, and is refused by name past it: the only way through is a shorter
   range that you name. It will not split, sample, or quietly measure a subset and report it as the whole. `--from` must
   be an **ancestor** of `--to`; where two orders exist the program refuses to choose one for you.

5. **Report** — `npm run harness -- report`. Exits: `0` written · `2` refused. **There is no exit `1`** — an empty run
   population still writes a report and exits `0`. The `2` cases are an unknown flag, and an `--out` that is not an
   absolute canonical path or that targets a reserved `.harness/state/` directory.

Every exit set is published per command by the manual and by the runtime itself with no arguments; quote that table, not
a remembered code. An unknown flag is refused **by name** at exit `2` with the allowlist printed.
`npm run check:harness` runs the self-test then the frozen compatibility cases, and is never a step of `npm run check`.
For each command that publishes a screen — `contract`, `census`, `evaluate`, `regress`, `report`, `validate`,
`workspace` — `<command> --help`, `<command> -h` and `help <command>` are the SAME screen byte for byte, and all exit
`0` while **changing nothing**: no commit measured, no state written, no gate run. `--help` is a MODE OF INVOCATION, not
a general flag, so a command with no own screen does not gain one — `list`, `show`, `taxonomy`, `modes`, `telemetry`,
`handoff`, `ledger`, `predicates`, `self-test`. **The invariant is stronger than that list: asking for help never runs
the command** — a no-screen command given `--help` prints the top-level screen and changes nothing. The bare
`harness -h` is likewise not equivalent to `harness --help`: it prints the top-level screen and exits `1`.

## 4. Vocabulary that must never be read loosely

- **`INCONCLUSIVE` is non-resolving and is never a direction.** It is neither pass nor fail, is never counted as either,
  and never declares the other side the winner. It is a different concept from the git skip code, and NON-RESOLVING is
  the word the aggregate output prints for it.
- **`ERROR` is a statement about the tool; `INCONCLUSIVE` is a statement about the evaluated state.** An errored trial
  is never averaged away because its siblings agreed.
- **Repetition does not make a flaky predicate safe.** ANY disagreement among the trials makes the side `INCONCLUSIVE`,
  and **a vote is never taken** — not a majority, not a best-of, not the last trial, not the most common state. At a
  flip rate near 0.5 a majority vote is wrong exactly half the time for EVERY N, so repetition is not a remedy in that
  regime; it can be an amplifier. The rule as `regress` renders it, §"Repeated evaluation", `.harness/README.md`.
- **Declared is not observed.** `source_commit` is _declared_; `judged_commit` is _observed_. `installed_state_digest`
  is declared by npm; `installed_tree_fingerprint` is observed by this tool. A record that conflates the two proves
  nothing. The fields and their order, §"the versioned verdict", `.harness/README.md`.
- **A run only means something if the tree and the build were observed, not assumed.** A carried-over tree or build
  state makes the repeat measure the assumption, not the commit.
- **Tamper and replay are detectable, not prevented.** A forged verdict is fenced and prefixed, a `run_id` in a trial
  log is digest-chained, and a replayed trial is re-derived rather than believed — a detector, not a security control.
  §"Repeated evaluation" and §"Ledgers", `.harness/README.md`.
- **A candidate is never the responsible party.** A comparison reports an _observed transition_; a boundary is a
  candidate at such a transition, and a candidate can be the boundary and still be innocent.
- **A transition is not a cause.** The classification describes the _shape_ of a diff, not why it failed.
- **`UNDEFINED` is not red.** A step the judged commit's own manifests do not declare has no command to run, so it is
  enumerated, non-resolving, and never a `FAIL`.
- **`GATE_PASS` is reserved for `scope: FULL_GATE`.** An `evaluate` run of a single named step, and an `evaluate` run
  with no gate, are both `NOT_A_GATE_PASS`.
- **`prior_observations` is a memory, not a verdict**: a count of prior runs of the same judged state and whether they
  disagreed. It asserts no rate, no bound and no exchangeability assumption.

## 5. The hidden assumptions

- The repository must be a real git working tree and the ref must resolve; both are refused **by name before any
  install**. Nothing checks shallowness, so a shallow clone silently bounds every range you ask for.
- `workspace prepare` performs a real `npm ci` against the registry — or `--offline`, which is a different measurement.
- The worktree lands outside the repository, and the install mutates the primary repository's shared git config.
- The gate child environment is sanitised — which does **not** close the registry channel of step 2.

## 6. Recorded NO-GO: `git bisect`

`git bisect` is a **recorded NO-GO** — no command, no flag, no stub, a shipped decision rather than a gap. The
falsifier, §"Recorded NO-GO" in `.harness/README.md`, states what would have to change for the decision to be revisited.

## 7. Two links, no third hop

- [`.harness/README.md`](../../.harness/README.md) — the operator manual: the decision surface, every command, the exit
  tables, the versioned verdict, the historical workspaces and the tamper-and-replay limits.
- [`.harness/docs/schemas.md`](../../.harness/docs/schemas.md) — the verdict and run-record schemas, field by field.
