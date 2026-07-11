# This Week in Philly — v2 Implementation Plan

**Status:** Proposed
**Companion to:** `V2_DESIGN.md`
**Date:** 2026-07-11

This plan reviews the v2 design, resolves its open questions (two of them with data), flags defects to fix before building, and sequences the work into five phases. Each phase ends with a verifiable checkpoint, and v1 keeps running until the final cutover.

---

## Part 1 — Design Review Findings

The design is sound overall: the three-way split (Haiku collection / Sonnet selection / scripted presentation) matches where judgment actually lives, and the migration path is correctly sequenced to keep v1 alive. The issues below are fixable but real.

### Defects to correct

**D1. `runner.sh` writes the report to the wrong directory.**
`HTML_PATH="$(dirname $WEEK_DIR)/report.html"` resolves to the *parent* of the week folder, so every week overwrites the same file. It should live inside the week dir. The script also has unquoted variables, passes no arguments to `attendance_check.py`, and `wait` without checking exit codes silently swallows failures of the parallel steps. Corrected version in Part 3.

**D2. `calendar_create.py` spec says "clears prior week's picks first."**
Wrong week. v1's render task clears the *target* (upcoming) week from Curated Events so re-runs don't duplicate. Clearing the prior week would destroy the attendance signal before `attendance_check.py` reads it if ordering ever slipped. Spec should read: "clears the target week's existing entries first."

**D3. "21 events" is an overstatement baked into two places.**
Selection explicitly allows fewer than 3 qualifying events per day. `calendar_create.py` and the architecture diagram should say "up to 21."

### Gaps to close

**G1. No Drive download step.** Every script consumes local paths, but v2's data lives in Google Drive. Whatever runs `runner.sh` in the cloud must first pull the week folder down. Add a `drive_sync.py` (download `YYYY-MM-DD/` folder by ID) as step 0 of `runner.sh`.

**G2. The picks-log location contradicts the preferred runner architecture.** The data layer keeps `event-picks-log.csv` local "because it's only touched by scripts that run locally" — but Open Question 3's preferred answer (option a, a third Routine) means those scripts *don't* run locally. If option (a) is chosen (it is — see Q3 below), the CSV must migrate to Drive in v2, not "later." `attendance_check.py` and `csv_log.py` then read/write it via the Drive API (download → mutate → re-upload within the run).

**G3. OAuth won't survive the cloud as specified.** `credentials.json` + persisted `token.json` at `~/.config/twip/` assumes a durable home directory; Routines have none. Plan: run the interactive consent flow once locally, then inject client ID/secret/refresh token as Routine environment secrets, with `common.py` reconstructing credentials from env. Critical sub-gotcha: a Google Cloud OAuth app left in **Testing** status expires refresh tokens after 7 days — the consent screen must be pushed to **Production** (no verification needed for personal-scope use) or the pipeline dies silently on week two.

**G4. No delivery/notification step.** v1 stubbed iMessage; v2 drops notification entirely. `drive_upload.py` produces a link that nothing sends to Greg. Recommend a small `notify.py` that emails the Drive link + 7-line digest to gsmolodrone@gmail.com via the Gmail API (same OAuth app, one more scope). Cheap to add, and it doubles as the failure-alert channel.

**G5. No failure story for the chain.** If Collection dies, Selection never fires and Sunday passes silently. Mitigations, in order of value: (1) `notify.py --failure` at the end of each Routine's error path; (2) document a manual re-fire runbook (each Routine is independently triggerable); (3) optionally give Selection a late-morning fallback cron that no-ops if `_selections.json` already exists and exits loudly if the manifest is missing.

**G6. `drive_upload.py` should be idempotent.** Re-runs will create duplicate `report.html` files. Search the folder for an existing file of the same name and update it in place instead of creating.

**G7. Skill files are full of absolute Mac paths.** All four skills (and the v1 task files they'll be adapted from) reference `/Users/molo/...` paths. Migration to `.claude/skills/` requires rewriting every path to repo-relative or env-var form, not just copying files.

### Minor

- Pin Routine model IDs at creation time against the then-current model list; `claude-sonnet-4-6` in the design may be superseded (`claude-haiku-4-5` is current for Haiku).
- Confirm the Routines cron timezone semantics (UTC vs. local) during the Phase 0 spike — `0 2 * * 0` in UTC is Saturday 9/10 PM ET, which would collect a day early.

---

## Part 2 — Open Questions, Resolved

**Q1. HTML rendering: script or Routine? → Script it.**
`events-report-format/SKILL.md` is already a pixel-level spec — exact hex colors, font sizes, markup snippets, fixed category order. That's a Jinja2 template that happens to be written in prose. The parts of the skill that are *not* templatable (verification searches, dedup preferences, blurb tone) belong to Selection anyway, not rendering. Port the spec to `templates/report.html.j2`, validate with a golden-file comparison against a real v1 report, keep the SKILL.md as the human-readable design reference for the template.

**Q2. Chrome connector in Routines? → Spike before building anything.**
This is the single biggest unknown and it gates Collection (Tiers 2–5 ≈ 23 of 29 sources... though Tier 4's 8 Meetup feeds are iCal via web_fetch, so effectively ~15 sources). Phase 0 runs a throwaway Routine to test it. Fallback is playwright via setup script + per-source extraction notes in `philadelphia-sources/SKILL.md`. Do not start Routine work until this answer is in hand.

**Q3. runner.sh trigger? → Option (a), a lightweight Presentation Routine.**
Cleanest separation, fully cloud (the whole point of v2), and per-run cost is trivial since it's just script execution. Accepted consequences: G1 (drive_sync) and G2 (CSV to Drive) become requirements. Option (b) — Selection runs the scripts itself — is the documented fallback if a third Routine proves operationally annoying; it would actually skip the Drive round-trip since Selection already has `_selections.json` locally.

**Q4. Songkick page cap impact? → Measured. Cap is safe.**
The picks log answers this today: of 84 Philadelphia Top 3 picks logged, exactly **2 came from Songkick (2.4%)**, and only 2 of 136 total logged rows (picks + honorable mentions) are Songkick-sourced. The specialist sources dominate (Iffy Books 14, Do215 12, PhilaMOCA 10, Ask A Punk 6, R5 5 of Top 3 picks). Cap at 4 pages with zero meaningful cost.

---

## Part 3 — Implementation Phases

### Phase 0 — Spike & decide (small; do first, blocks everything cloud-side)

1. Push this repo to GitHub as private `this-week-in-philly` (migration step 1).
2. **Routine environment spike** — create one throwaway Routine and verify in a single run:
   - Is `get_page_text` / Chrome available? (→ Q2)
   - Can it install playwright via setup script if not?
   - Do env secrets work, and can bash `curl` an external API? (→ chaining viability)
   - Cron timezone semantics.
   - Available model IDs.
3. Record answers in this doc; if Chrome is unavailable, add a "playwright extraction notes" task to Phase 4.

**Exit criteria:** every cloud assumption in the design is confirmed or has a chosen fallback.

### Phase 1 — Repo restructure (small)

1. Move `v1/Skills/*` → `.claude/skills/*` (all four; keep `v1/` untouched as the running-system reference until cutover).
2. Rewrite absolute Mac paths in the migrated skills to repo-relative / env-var form (G7).
3. Scaffold `scripts/`, `templates/`, `requirements.txt` (`google-api-python-client`, `google-auth-oauthlib`, `spotipy`, `jinja2`), `README.md`.
4. `.gitignore`: `credentials.json`, `token.json`, `.env`, `__pycache__/`.

**Exit criteria:** repo matches the design's target structure; no secrets committable.

### Phase 2 — Script suite, built and tested locally (the bulk of the work)

Build against an archived week's real data (June 22 per the design's migration step 3). Every script: standalone, CLI args + env vars, `--dry-run` where it mutates external state (calendar, Drive, CSV).

Build order (dependency-driven):

| Order | Script | Notes |
|---|---|---|
| 1 | `common.py` | Google credentials from env (G3-compatible from day one), Drive helpers, week-date math |
| 2 | `spotify_lookup.py` | ThreadPoolExecutor; writes `_spotify.json`; no-match → null, never guess |
| 3 | `templates/report.html.j2` + `html_render.py` | Port `events-report-format/SKILL.md` faithfully; **golden test:** render June 22 `_selections.json` and diff structurally against the v1-produced HTML |
| 4 | `csv_log.py` | Idempotent on week+title (per design); price-tier inference from `cost` |
| 5 | `attendance_check.py` | Calendar presence → `attended` true/false for last week's rows |
| 6 | `calendar_create.py` | Clears **target** week first (D2); end-time heuristics from v1 (literary +90m, film +2h, concert +3h, festival +6h); up to 21 events (D3) |
| 7 | `drive_upload.py` | `disableConversionToGoogleType`; update-in-place if filename exists (G6) |
| 8 | `drive_sync.py` | Download week folder from Drive to local temp (G1); upload changed CSV back |
| 9 | `notify.py` | Email Drive link + digest; `--failure` mode for error alerts (G4/G5) |
| 10 | `runner.sh` | Corrected version below |

Corrected `runner.sh`:

```bash
#!/bin/bash
set -euo pipefail
WEEK_DIR="$1"                       # local path to YYYY-MM-DD dir (drive_sync populates it)
HTML_PATH="$WEEK_DIR/report.html"   # D1: inside the week dir, not its parent

python scripts/drive_sync.py --pull "$WEEK_DIR"

# attendance_check must finish before csv_log (shared CSV);
# spotify_lookup is independent — run both concurrently
python scripts/attendance_check.py --week-dir "$WEEK_DIR" &
ATTEND_PID=$!
python scripts/spotify_lookup.py "$WEEK_DIR" &
SPOTIFY_PID=$!
wait "$ATTEND_PID"; wait "$SPOTIFY_PID"   # -e propagates either failure

python scripts/html_render.py "$WEEK_DIR" "$HTML_PATH"

python scripts/calendar_create.py "$WEEK_DIR" &
CAL_PID=$!
python scripts/drive_upload.py "$HTML_PATH" &
UPLOAD_PID=$!
python scripts/csv_log.py "$WEEK_DIR" &
CSV_PID=$!
wait "$CAL_PID"; wait "$UPLOAD_PID"; wait "$CSV_PID"

python scripts/drive_sync.py --push-csv
python scripts/notify.py --week-dir "$WEEK_DIR"
```

**Exit criteria:** full `runner.sh` run against June 22 data produces an HTML report that matches the v1 report, correct calendar events in a test calendar, and correct CSV rows — all from one command.

### Phase 3 — Auth & data layer (one-time setup + one dual-write Sunday)

1. Google Cloud project: enable Calendar, Drive (and Gmail if `notify.py` uses it) APIs; OAuth consent screen → **Production** status (G3); run local consent flow; capture refresh token.
2. Spotify developer app; client credentials.
3. Store all secrets as env vars locally and as Routine secrets later; never in the repo.
4. Migrate `event-picks-log.csv` to Drive (G2); point scripts at it via `drive_sync.py`.
5. **Dual-write Sunday** (migration step 4): update the v1 desktop collection task to also write JSONs to Drive; verify Selection-readable structure; v1 remains the system of record.

**Exit criteria:** scripts run end-to-end using only env-var auth (no `~/.config` files); one real Sunday's data lands in Drive alongside v1's iCloud copy.

### Phase 4 — Routines (one per week, in dependency order)

1. **Collection Routine** — Haiku, cron Sunday 2:00 AM ET (timezone per Phase 0 findings), Drive + Calendar connectors, Songkick 4-page cap, Chrome-or-playwright per Phase 0. Run parallel with v1 for one week; diff source JSONs against v1's.
2. **Selection Routine** — Sonnet, API trigger; wire Collection's completion `curl`; verify `_selections.json` in Drive; blurb quality check against v1's output for the same week. Add fallback cron + failure notification (G5).
3. **Presentation Routine** — lightweight, API-triggered by Selection; clones repo, runs `runner.sh`. Secrets: Google + Spotify env vars.

**Exit criteria:** an end-to-end cloud run (Collection → Selection → Presentation) completes with the Mac closed, and the report email arrives.

### Phase 5 — Validation & cutover

1. Run v1 and v2 in full parallel for 1–2 Sundays (separate Drive filenames / test calendar for v2 to avoid collisions).
2. Compare per stage: source yield vs. v1 collection, Top 3 overlap + blurb quality vs. v1 selection, byte-level report diff.
3. Check Haiku specifically: did collection JSON quality hold? (This is the model-downgrade risk point; revert Collection to Sonnet if extraction quality slipped.)
4. Decommission the three v1 desktop tasks (migration step 8); note token/cost per session from the Routines dashboard as the v2 baseline.

**Exit criteria:** two consecutive clean cloud Sundays; v1 disabled; `v1/` directory kept in repo as historical reference.

---

## Part 4 — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Chrome unavailable in Routines | Medium | High — blocks ~15 sources | Phase 0 spike; playwright fallback with updated extraction notes |
| Google refresh token expiry (Testing status) | High if unaddressed | High — silent death week 2 | Consent screen to Production in Phase 3 |
| Haiku collection quality regression | Medium | Medium — garbage-in for selection | Parallel-run diff in Phase 5 step 3; revert to Sonnet is a one-line change |
| API chaining not supported as designed | Low–Medium | Medium | Phase 0 spike; fallback = scheduled Selection with manifest-existence guard |
| Template drift vs. desired report look | Low | Low — Q1 analysis shows spec is stable | Golden test in Phase 2; SKILL.md retained as spec of record |
| Silent Sunday failure | Medium | Medium | `notify.py --failure` + fallback cron (G5) |

---

## Part 5 — Suggested Order of Attack

Phase 0 and Phase 2 are independent — the spike can run while scripts are being built, since scripts are testable entirely locally. Phase 1 is an afternoon. The critical path is **Phase 0 → Phase 3 → Phase 4 → Phase 5** because each depends on cloud facts or real Sundays. Realistic calendar time: **4–5 weeks**, dominated by the one-Sunday-per-validation cadence, not by build effort.
