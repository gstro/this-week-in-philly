#!/bin/bash
# The one place the workflows learn which engine a pipeline step runs on:
# the Python scripts in scripts/ or the TypeScript port in src/ (built to
# dist/ by `npm run build`). $ENGINE is "python" (the default) or "ts"; each
# workflow sets it from its own repo variable (COLLECTION_ENGINE for
# collection.yml and collection-check.yml, PRESENTATION_ENGINE for
# presentation.yml) or a workflow_dispatch `engine` input, so a stage can be
# cut over, and rolled back, without a PR. Tier D of docs/TS_PORT.md; this
# script is deleted with the Python, after which the workflows call node
# directly.
#
#   ENGINE=ts scripts/ci/pipeline.sh check-yield data/2026-10-19
#
# Steps (arguments are passed through unchanged; both engines take the same):
#   target-week        print the Monday the run should cover
#   collect            collect_week      / collectWeek
#   check-yield        check_yield       / checkYield
#   prepare-selection  prepare_selection_input / prepareSelectionInput
#   merge-selections   merge_selections  / mergeSelections
#   check-selection    check_selection   / checkSelection
#   present            runner.sh         / runPresentation
set -euo pipefail

ENGINE="$(printf %s "${ENGINE:-python}" | tr '[:upper:]' '[:lower:]')"  # Actions compares case-insensitively
if [ "$ENGINE" != "python" ] && [ "$ENGINE" != "ts" ]; then
  echo "::error::ENGINE must be 'python' or 'ts', got '$ENGINE'" >&2
  exit 2
fi
if [ $# -lt 1 ]; then
  echo "usage: pipeline.sh <step> [args...]" >&2
  exit 2
fi
STEP="$1"
shift

# run <python script> <ts module> [args...]
run() {
  local py="$1" ts="$2"
  shift 2
  if [ "$ENGINE" = "ts" ]; then
    exec node "dist/$ts.js" "$@"
  fi
  exec python "scripts/$py.py" "$@"
}

case "$STEP" in
  target-week)
    if [ "$ENGINE" = "ts" ]; then
      exec node dist/targetWeek.js "$@"
    fi
    exec python3 -c "import sys; sys.path.insert(0, 'scripts'); import common; print(common.target_week_monday().isoformat())"
    ;;
  collect) run collect_week collectWeek "$@" ;;
  check-yield) run check_yield checkYield "$@" ;;
  prepare-selection) run prepare_selection_input prepareSelectionInput "$@" ;;
  merge-selections) run merge_selections mergeSelections "$@" ;;
  check-selection) run check_selection checkSelection "$@" ;;
  present)
    if [ "$ENGINE" = "ts" ]; then
      exec node dist/runPresentation.js "$@"
    fi
    exec bash "$(cd "$(dirname "$0")/.." && pwd)/runner.sh" "$@"
    ;;
  *)
    echo "pipeline.sh: unknown step '$STEP'" >&2
    exit 2
    ;;
esac
