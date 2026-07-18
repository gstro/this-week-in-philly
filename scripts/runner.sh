#!/bin/bash
# Presentation pipeline: turns a week's _selections.json into the HTML
# report, calendar events, and CSV log rows. Invoked by
# .github/workflows/presentation.yml (on: push, paths: data/**/_selections.json).
#
# Corrected version per V2_IMPLEMENTATION_PLAN.md D1: writes the report to a
# per-week path (not a single file every week overwrites), quotes all
# variables, and checks exit codes on the parallel steps via `wait` after
# `set -e` -- a bare `wait` with no PID would swallow failures silently.
set -euo pipefail
WEEK_DIR="$1"                                         # data/YYYY-MM-DD -- already checked out by the Actions runner
HTML_PATH="docs/weeks/$(basename "$WEEK_DIR").html"   # D1: named per-week, not a single overwritten file

# attendance_check must finish before csv_log (shared CSV);
# spotify_lookup is independent -- run both concurrently
python scripts/attendance_check.py --week-dir "$WEEK_DIR" &
ATTEND_PID=$!
python scripts/spotify_lookup.py "$WEEK_DIR" &
SPOTIFY_PID=$!
wait "$ATTEND_PID"
wait "$SPOTIFY_PID"

python scripts/html_render.py "$WEEK_DIR" "$HTML_PATH"

python scripts/calendar_create.py "$WEEK_DIR" &
CAL_PID=$!
python scripts/csv_log.py "$WEEK_DIR" &
CSV_PID=$!
wait "$CAL_PID"
wait "$CSV_PID"

# The calling workflow (presentation.yml) commits and pushes:
#   docs/weeks/*.html, docs/index.html, data/*/_spotify.json, data/event-picks-log.csv
