# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An automated weekly events-curation pipeline for Philadelphia: every Sunday it collects ~245 events from ~29 sources, selects Top 3 picks per day against Greg's interests, and delivers an HTML report plus Google Calendar entries and a CSV log.

**Current state: documentation only — no code exists yet.** The repo holds reference docs for v1 (the currently running desktop version) and the design/plan for v2 (the cloud rewrite about to be built). There are no build, lint, or test commands until v2's `scripts/` suite lands.

## Where things are

- `docs/V2_DESIGN.md` — the v2 architecture (cloud Routines + Python scripts)
- `docs/V2_IMPLEMENTATION_PLAN.md` — the build plan; includes design-review corrections that **supersede the design doc where they conflict** (e.g., the runner.sh sketch in the design has known bugs; the plan has the corrected version)
- `docs/v1/` — snapshot of the v1 system that still runs on Greg's Mac via desktop scheduled tasks. Reference material; changing these files does not change the running system.
  - `Scheduled/*/SKILL.md` — the three v1 task definitions (collection, selection, presentation)
  - `Skills/*/SKILL.md` — the four domain skills (sources, interests, selection philosophy, report format)
  - `Data/event-picks-log.csv` — historical picks log (includes pre-Philly Austin rows)

## Pipeline architecture

Three stages, chained by file handoffs. This structure is the same in v1 and v2; only the infrastructure changes (v1: three Mac scheduled tasks passing files through iCloud; v2: two Claude Code Routines — Collection on Haiku, Selection on Sonnet — passing files through Google Drive, plus a Python script suite for everything after selection).

```
Collection  → per-source JSONs + _manifest.json   (scrape 29 sources, tier-ordered cheapest-first)
Selection   → _selections.json                    (dedupe, score, Top 3/day, write "why" blurbs)
Presentation → HTML report, calendar events, CSV  (deterministic; v2 scripts this entirely)
```

Tasks are deliberately thin; all domain logic lives in the skill files. Selection is the only stage that generates prose (the `why` blurbs) — that's why it keeps Sonnet in v2 while everything else gets cheaper.

## Key contracts (change with care)

- **`_selections.json` schema** — the interface between Selection and everything downstream. Defined with a full example in `docs/v1/Scheduled/philly-events-selection/SKILL.md`. The nine `category` strings are canonical (emoji included, exact match).
- **HTML report spec** — `docs/v1/Skills/events-report-format/SKILL.md` is a pixel-level spec (exact colors, sizes, markup). In v2 it becomes `templates/report.html.j2`; the SKILL.md remains the spec of record.
- **Picks log columns** — `city, week_of, day, date, title, venue, category, source, rank, price_tier, spotify_link, tags, attended`. `csv_log.py` must stay idempotent on week+title.
- **Week window convention** — every stage covers the Monday immediately following the run date through the Sunday after (computed at runtime, never hardcoded).
- **Attendance feedback loop** — Greg deletes Curated Events calendar entries he didn't attend; presence at week's end means attended. Collection's Step 0 writes this back to the CSV. This is why `calendar_create.py` must clear only the *target* (upcoming) week, never the prior week.

## v2 conventions (once scripts exist)

Per the implementation plan: scripts live in `scripts/`, each standalone with CLI args + env-var config, `--dry-run` on anything that mutates external state (Calendar, Drive, CSV). Google auth is built from env vars from day one (`credentials.json`/`token.json` never live in the repo — Routines have no persistent home dir). `runner.sh` orchestrates: attendance_check must complete before csv_log (shared CSV); spotify_lookup must complete before html_render.
