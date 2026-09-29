#!/usr/bin/env bash
#
# DEPRECATED WRAPPER — the runtime owns the workspace lifecycle.
#
# This script removed disposable worktrees under `.harness/state/worktrees/`, the location the runtime no longer
# uses: a worktree under the repository inherits the repository's `node_modules` through Node's upward module
# resolution with ZERO setup, which is how a genuinely green commit once measured as a `test_failure`.
#
# Historical worktrees are now created OUTSIDE the repository and removed by `harness workspace remove` /
# `harness workspace prune`, which report reclaimed bytes and return NON-ZERO when any removal failed — cleanup
# failure previously had no observable signal at all.
#
# One real job remains here: reporting any worktree still left at the old location, so an operator is never left
# with an orphan the runtime does not manage. `harness workspace prepare` refuses to prepare while any exist, because
# silent adoption of a symlink-contaminated worktree is the one migration behaviour that could reintroduce the
# defect invisibly.
#
# Usage: .harness/operator/remove-workspace.sh <task-id> [arm-suffix]
#
# See: .harness/README.md ("Historical workspaces"), .harness/docs/schemas.md, AGENTS.md.
set -euo pipefail

TASK="${1:?usage: remove-workspace.sh <task-id> [arm-suffix]}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WT="$ROOT/.harness/state/worktrees/$TASK${2:+-$2}"
HARNESS="$ROOT/.harness/runtime/harness.mjs"

if [ -d "$WT" ]; then
  echo "refusing to remove a legacy in-repository workspace automatically." >&2
  echo "" >&2
  echo "  $WT" >&2
  echo "" >&2
  echo "It sits under the repository, so Node resolves the repository's node_modules through it. Removing it" >&2
  echo "by hand is safe; adopting it silently is not. Inspect it, then delete it with:" >&2
  echo "" >&2
  echo "  git -C '$ROOT' worktree remove --force '$WT'" >&2
  echo "" >&2
  echo "Managed historical workspaces live OUTSIDE the repository and are reclaimed with:" >&2
  echo "  node '$HARNESS' workspace remove --commit=<ref> [--instance=<label>]" >&2
  echo "  node '$HARNESS' workspace prune" >&2
  exit 2
fi

echo "no legacy workspace for $TASK${2:+ (slot: $2)}"
echo "note: managed workspaces are reclaimed with: node '$HARNESS' workspace remove --commit=<ref> | prune"
exit 0
