# Failure taxonomy

Purpose: answer **"why did this run fail?"** — not "what was the error text?".

The categories are intentionally few and stable. `mechanical` categories are assigned automatically by
[`../runtime/harness.mjs`](../runtime/harness.mjs) when the gate fails; `judgement` categories are supplied by the
evaluator via `--failure=<category>` when the mechanical gate passes but the run is still considered failed.

| Category               | Kind       | Meaning                                                                   | Typical signal                                               |
| ---------------------- | ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `implementation`       | judgement  | Change exists but behaves incorrectly or is incomplete against acceptance | acceptance criteria not met; review finding                  |
| `wrong_file`           | judgement  | Edits landed in the wrong place, or an unrelated file was modified        | unexpected paths in `changed_files`                          |
| `stale_state`          | judgement  | The agent acted on a version of a file/schema that had already changed    | diff applies to outdated content; version/conflict errors    |
| `tool_error`           | judgement  | A tool invocation itself failed or returned malformed output              | tool errors in the transcript                                |
| `test_failure`         | mechanical | Gate failed at a test step                                                | `test:server` / `test:ui` steps, non-zero exit               |
| `typecheck_failure`    | mechanical | Gate failed at a typecheck step                                           | `typecheck:*` steps, non-zero exit                           |
| `lint_failure`         | mechanical | Gate failed at the lint step                                              | `lint` step, non-zero exit                                   |
| `edit_cascade`         | judgement  | Repeated failed edits; the edit could not be recovered                    | repeated `apply_diff`/patch failures                         |
| `redundant_work`       | judgement  | Work was repeated that had already been done                              | repeated reads/runs of unchanged inputs                      |
| `context_exhaustion`   | judgement  | Context limits forced truncation, compaction or a restart                 | session restarted; facts re-discovered                       |
| `budget`               | judgement  | Run ended because a turn/tool/time budget was hit                         | gateway reported budget/turn limit                           |
| `premature_completion` | judgement  | The agent stopped and claimed completion before the work was done         | `agent_claimed_done=true` with `mechanically_verified=false` |
| `environment`          | mechanical | Failure of the local environment (docker, wrangler, node, network, build) | `build:*` steps, or infrastructure errors                    |
| `unclassified`         | —          | Failure observed but not yet categorised                                  | gate failed with no mapped step                              |

## Rules

1. One primary category per run. If several apply, record the earliest cause in the trajectory, not the loudest symptom.
2. `false_done` (`agent_claimed_done` and not `mechanically_verified`) is a **classification outcome**, not a category;
   it is usually explained by `premature_completion` or by whichever mechanical category failed.
3. Do not extend this list for individual error messages. If a new class genuinely recurs, add one row and say which
   runs it came from.
4. A run that fails the gate counts as a failure even if the underlying change was later fixed by hand — the evidence
   recorded is the run, not the final repository state.

## Where the categories are enforced

- [`../runtime/harness.mjs`](../runtime/harness.mjs) `TAXONOMY` constant — validation of `--failure=...`, and derivation
  of mechanical categories from the failing gate step.
- `harness.mjs report` — histograms `failure_categories` into each generated report under `.harness/state/reports/`.
