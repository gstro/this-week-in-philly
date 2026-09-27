#!/usr/bin/env bash
# Lands a branch on the base branch through a pull request, then merges it
# immediately -- the only way anything reaches `main` since the 2026-09-26
# repository ruleset (changes must go through a PR, zero required approvals,
# merge commits only, no bypass actors). Used by collection.yml,
# presentation.yml and selection-merge.yml in place of a bare `git push`.
#
# Usage:
#   merge_via_pr.sh --branch B --title T [--body TEXT] [--base main] [--push]
#
#   --push   force-push HEAD to refs/heads/B first. Bot branches aren't
#            protected, so forcing makes a same-week re-run converge rather
#            than fail. Without it, B must already exist on origin (the
#            Selection Routine's own claude/* branch).
#   --base   defaults to main; exists so the mechanics can be exercised
#            against an unprotected sandbox branch.
#
# Auth comes from GH_TOKEN (the workflow's github.token). A merge made with
# GITHUB_TOKEN does NOT fire other workflows' `on: push` -- callers that need
# a downstream workflow dispatch it explicitly (see selection-merge.yml).
set -euo pipefail

branch=""
title=""
body=""
base="main"
push=false

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) branch="$2"; shift 2 ;;
    --title) title="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --push) push=true; shift ;;
    *) echo "merge_via_pr: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$branch" ] || [ -z "$title" ]; then
  echo "merge_via_pr: --branch and --title are required" >&2
  exit 2
fi
if [ "$branch" = "$base" ]; then
  echo "merge_via_pr: refusing to open a PR from $base into itself" >&2
  exit 2
fi
[ -n "$body" ] || body="Automated: $title"

if [ "$push" = true ]; then
  git push --force origin "HEAD:refs/heads/$branch"
fi

# Reuse an already-open PR for this branch (a re-run after a failed merge),
# otherwise open one. `gh pr create` needs --body when non-interactive.
pr_url="$(gh pr list --head "$branch" --base "$base" --state open --json url --jq '.[0].url // ""')"
if [ -z "$pr_url" ]; then
  pr_url="$(gh pr create --base "$base" --head "$branch" --title "$title" --body "$body")"
fi
echo "merge_via_pr: $pr_url"

# GitHub computes mergeability asynchronously; right after creation it reads
# UNKNOWN (seen by hand on 2026-09-27). Wait for a real answer before merging.
mergeable="UNKNOWN"
for _ in $(seq 1 30); do
  mergeable="$(gh pr view "$pr_url" --json mergeable --jq .mergeable)"
  [ "$mergeable" != "UNKNOWN" ] && break
  sleep 2
done

if [ "$mergeable" != "MERGEABLE" ]; then
  echo "::error::merge_via_pr: $pr_url is not mergeable (mergeable=$mergeable); leaving it open for a human."
  exit 1
fi

if ! gh pr merge "$pr_url" --merge --delete-branch; then
  echo "::error::merge_via_pr: merging $pr_url failed; leaving it open for a human."
  exit 1
fi
echo "merge_via_pr: merged $pr_url into $base"
