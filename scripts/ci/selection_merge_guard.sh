#!/usr/bin/env bash
# Decides whether a pushed claude/* branch is a Selection Routine result that
# selection-merge.yml may merge into main without a human looking at it.
#
# Usage: selection_merge_guard.sh <base-ref> <head-ref>
#   Prints the week directory (data/YYYY-MM-DD) and exits 0 when it qualifies.
#   Prints the reason and exits 1 when it doesn't -- the caller leaves the
#   branch for a human.
#
# Qualifies only if, relative to the merge base with <base-ref>:
#   1. exactly one file changed,
#   2. that change ADDS data/YYYY-MM-DD/_selection_annotations.json (a new
#      week's Selection, not an edit -- a modified annotations file is a
#      backfill or a dev session's change, and republishing a historical
#      week is what caused the PR #26 incident), and
#   3. that week's _candidates.json is already on <base-ref> (Collection
#      really ran for it).
# Anything else -- including interactive Claude Code dev sessions, which also
# push to claude/* branches -- goes through normal human review.
set -euo pipefail

base="${1:?usage: selection_merge_guard.sh <base-ref> <head-ref>}"
head="${2:?usage: selection_merge_guard.sh <base-ref> <head-ref>}"

mapfile -t changes < <(git diff --name-status "$base...$head")

if [ "${#changes[@]}" -ne 1 ]; then
  echo "declined: expected exactly 1 changed file relative to $base, found ${#changes[@]}"
  exit 1
fi

status="${changes[0]%%$'\t'*}"
path="${changes[0]#*$'\t'}"

if [ "$status" != "A" ]; then
  echo "declined: $path has status '$status', not a newly added file"
  exit 1
fi

if ! [[ "$path" =~ ^data/[0-9]{4}-[0-9]{2}-[0-9]{2}/_selection_annotations\.json$ ]]; then
  echo "declined: $path is not a week's _selection_annotations.json"
  exit 1
fi

week_dir="${path%/_selection_annotations.json}"
if ! git cat-file -e "$base:$week_dir/_candidates.json" 2>/dev/null; then
  echo "declined: $week_dir/_candidates.json is not on $base (Collection hasn't landed that week)"
  exit 1
fi

echo "$week_dir"
