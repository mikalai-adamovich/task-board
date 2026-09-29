#!/usr/bin/env bash
#
# DEPRECATED WRAPPER — the runtime owns the workspace lifecycle.
#
# Historical fact that motivated this file existing, and the reason it no longer does anything itself:
# this script used to create `node_modules` SYMLINKS into the primary checkout. That produced a FALSE REGRESSION
# (a green commit measured with today's dependencies flipped to `test_failure`) and, far worse, a DATA-LOSS hazard:
# `npm ci` DESTROYS the target of a symlinked `node_modules` (`npm warn reify Removing non-directory <path>/node_modules`
# replaces the link with a real directory and deletes the victim's entire contents). With a workspaces root and a
# NESTED `ui/node_modules -> victim` link, a root `npm install` destroyed the victim too.
#
# The symlink step is REMOVED, not made conditional and not made opt-in. There is no code path left in this repository
# that can create a `node_modules` symlink. The replacement is `harness workspace prepare`, which creates a detached
# linked worktree at a root OUTSIDE the repository, installs the historical commit's OWN lockfile into it, and records
# what it did in a durable attestation.
#
# See: .harness/README.md ("Historical workspaces"), .harness/docs/schemas.md, AGENTS.md.
#
# Usage: node .harness/runtime/harness.mjs workspace prepare --commit=<ref> [--instance=<label>] [--offline] [--no-install] [--keep]
#
# This wrapper exists only so the old invocation fails LOUDLY and points at the replacement. It is a thin
# delegator: it cannot create a symlink, cannot install, and cannot check out anything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cat >&2 <<'EOF'
prepare-workspace.sh is a DEPRECATED wrapper and no longer prepares a workspace.

It used to link the primary checkout's node_modules into a worktree. That was removed entirely: `npm ci` destroys
the target of a symlinked node_modules, and linking today's dependencies flipped a green commit to `test_failure`
without any setup. Nothing in this repository creates a node_modules symlink any more.

Use the runtime command instead — it creates a worktree OUTSIDE the repository, installs that commit's own lockfile,
and records the resulting environment:

    node .harness/runtime/harness.mjs workspace prepare --commit=<ref> [--instance=<label>] [--offline] [--keep]
    node .harness/runtime/harness.mjs workspace show
    node .harness/runtime/harness.mjs workspace remove --commit=<ref> [--instance=<label>]
    node .harness/runtime/harness.mjs workspace prune

This wrapper is a delegator only. It never creates a symlink, never installs, and never checks anything out.
EOF

exit 2
