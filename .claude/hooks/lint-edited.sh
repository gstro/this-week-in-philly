#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): lint the file Claude just edited and feed
# errors back (exit 2) so they get fixed in the same turn. Lint only -- never
# formats (the repo isn't ruff-format clean; auto-formatting would churn
# unrelated lines). Anything outside scripts/**.py and src/**.ts exits 0
# immediately, which keeps this inert for the Selection Routine, whose only
# edits are data/<week>/_selection_annotations.json. See docs/DEV_ENVIRONMENT.md.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
command -v jq >/dev/null 2>&1 || exit 0
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
[ -n "$file" ] || exit 0
rel="${file#"$root"/}"

case "$rel" in
  scripts/*.py)
    ruff="$root/.venv/bin/ruff"
    [ -x "$ruff" ] || ruff="$(command -v ruff)" || exit 0
    out="$("$ruff" check --quiet "$file" 2>&1)" && exit 0
    ;;
  src/*.ts)
    eslint="$root/node_modules/.bin/eslint"
    [ -x "$eslint" ] || exit 0
    out="$(cd "$root" && "$eslint" "$file" 2>&1)" && exit 0
    ;;
  *)
    exit 0
    ;;
esac

printf 'Lint errors in %s:\n%s\n' "$rel" "$out" >&2
exit 2
