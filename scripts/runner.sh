#!/bin/bash
# Presentation pipeline: turns a week's _selections.json into the HTML
# report and calendar events. Invoked by
# .github/workflows/presentation.yml (on: push, paths: data/**/_selections.json).
#
# Corrected version per V2_IMPLEMENTATION_PLAN.md D1: writes the report to a
# per-week path (not a single file every week overwrites), quotes all
# variables, and checks exit codes rather than swallowing failures silently.
#
# csv_log.py / attendance_check.py (the attendance feedback loop, per
# CLAUDE.md's "Attendance feedback loop") are deliberately NOT run here --
# deferred by decision until the rest of the pipeline is proven end to end,
# not because they're broken. Both keep their own tests so they don't rot
# while shelved. When the loop is revisited: attendance_check must still
# finish before csv_log (they share data/event-picks-log.csv), and that file
# doesn't exist yet -- it needs an init/seed decision first.
set -euo pipefail
WEEK_DIR="$1"                                         # data/YYYY-MM-DD -- already checked out by the Actions runner
HTML_PATH="docs/weeks/$(basename "$WEEK_DIR").html"   # D1: named per-week, not a single overwritten file

# Only calendar_create.py mutates anything external (the real "Curated
# Events" calendar) -- spotify_lookup.py and html_render.py only ever write
# inside the repo, so they run for real even under --dry-run.
DRY_RUN_FLAG=""
if [ "${2:-}" = "--dry-run" ]; then
  DRY_RUN_FLAG="--dry-run"
fi

python scripts/spotify_lookup.py "$WEEK_DIR"

python scripts/html_render.py "$WEEK_DIR" "$HTML_PATH"

if [ -n "$DRY_RUN_FLAG" ]; then
  python scripts/calendar_create.py "$WEEK_DIR" --dry-run
else
  python scripts/calendar_create.py "$WEEK_DIR"
fi

# The calling workflow (presentation.yml) commits and pushes:
#   docs/weeks/*.html, docs/index.html, data/*/_spotify.json
