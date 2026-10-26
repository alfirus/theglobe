#!/usr/bin/env bash
# guard-no-git-objects.sh — fail if a git TREE contains a committed git object
# store or nested .git entry (PR #11 follow-up, kanban t_1c370a08).
#
# Scoped to the tree, NOT the working copy, so local build output,
# node_modules, or the checkout's own .git directory never trip it.
#
# Rejects any tree path that:
#   1. lives under a top-level objects/ directory — this covers loose objects
#      (objects/??/*) and packfiles (*.pack / *.idx) as well, or
#   2. has any path component named .git (top-level or nested .git dir/file).
#
# Usage:
#   bash scripts/guard-no-git-objects.sh [ref]   # check a ref's tree (default: HEAD)
#   bash scripts/guard-no-git-objects.sh --staged  # check staged (index) paths
set -euo pipefail

list_paths() {
  if [[ "${1:-HEAD}" == "--staged" ]]; then
    git diff --cached --name-only --diff-filter=ACMRT -z | tr '\0' '\n'
  else
    local ref="${1:-HEAD}"
    if ! git rev-parse --verify --quiet "$ref" >/dev/null; then
      echo "guard-no-git-objects: ref '$ref' does not exist" >&2
      exit 1
    fi
    git ls-tree -r --name-only -z "$ref" | tr '\0' '\n'
  fi
}

violations="$(list_paths "${1:-HEAD}" | grep -E -e '^objects/' -e '(^|/)\.git($|/)' || true)"

if [[ -n "$violations" ]]; then
  count="$(printf '%s\n' "$violations" | wc -l | tr -d ' ')"
  echo "guard-no-git-objects: FAIL — $count forbidden path(s) in scope:" >&2
  printf '%s\n' "$violations" >&2
  echo 'A git object store (objects/) or .git entry must never be committed (PR #11).' >&2
  exit 1
fi

echo 'guard-no-git-objects: OK — no objects/ or .git paths in scope.'
