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

Three stages, chained by file handoffs. This structure is the same in v1 and v2; only the infrastructure changes (v1: three Mac scheduled tasks passing files through iCloud; v2: two Claude Code Routines — Collection on Haiku, Selection on Sonnet — passing files through the GitHub repo via `git push`, with GitHub Actions triggering the Python script suite for everything after selection, and GitHub Pages serving the report).

```
Collection  → per-source JSONs + _manifest.json   (scrape 29 sources, tier-ordered cheapest-first)
Selection   → _selections.json                    (dedupe, score, Top 3/day, write "why" blurbs)
Presentation → HTML report, calendar events, CSV  (deterministic; v2 scripts this entirely)
```

Tasks are deliberately thin; all domain logic lives in the skill files. Selection is the only stage that generates prose (the `why` blurbs) — that's why it keeps Sonnet in v2 while everything else gets cheaper.

## Key contracts (change with care)

- **`_selections.json` schema** — the interface between Selection and everything downstream. Defined with a full example in `docs/v1/Scheduled/philly-events-selection/SKILL.md` (v1 original, unchanged) and `.claude/skills/philly-events-selection/SKILL.md` (v2's Selection Routine task, adapted for repo-relative paths and `scripts/prepare_selection_input.py`'s pre-deduped `_candidates.json` input — same schema, same nine canonical `category` strings). The nine `category` strings are canonical (emoji included, exact match).
- **HTML report spec** — `docs/v1/Skills/events-report-format/SKILL.md` is a pixel-level spec (exact colors, sizes, markup). In v2 it becomes `templates/report.html.j2`; the SKILL.md remains the spec of record.
- **Picks log columns** — `city, week_of, day, date, title, venue, category, source, rank, price_tier, spotify_link, tags, attended`. `csv_log.py` must stay idempotent on week+title.
- **Week window convention** — every stage covers the Monday immediately following the run date through the Sunday after (computed at runtime, never hardcoded).
- **Attendance feedback loop** — Greg deletes Curated Events calendar entries he didn't attend; presence at week's end means attended. Collection's Step 0 writes this back to the CSV. This is why `calendar_create.py` must clear only the *target* (upcoming) week, never a week that has already started. Enforced, not just documented: `calendar_create.py`'s `week_has_already_begun()` skips the Calendar write entirely when the target week's Monday is in the past (Eastern), prints why, and exits 0 so the report still renders and publishes. `--force-calendar` overrides. This exists because merging PR #26 pushed a backfill to a *historical* week's `_selection_annotations.json`, which matches `presentation.yml`'s path filter and fired Presentation against the week of 2026-08-17 after it had ended — wiping and recreating all 21 entries and destroying that week's attendance signal. **`data/2026-08-17`'s calendar week is knowingly wrong** and was accepted as lost; no CSV was affected, since `attendance_check.py`/`csv_log.py` are shelved out of `runner.sh`.

## v2 conventions (once scripts exist)

Per the implementation plan: scripts live in `scripts/`, each standalone with CLI args + env-var config, `--dry-run` on anything that mutates external state (Calendar, Drive, CSV). Google auth is built from env vars from day one (`credentials.json`/`token.json` never live in the repo — Routines have no persistent home dir). `runner.sh` orchestrates: attendance_check must complete before csv_log (shared CSV); spotify_lookup → spotify_playlist → html_render (the playlist needs lookup's `_spotify.json` artist matches; the report header needs the playlist's `_playlist.json` URL).

Two distinct Spotify auth flows, deliberately: `spotify_lookup.py` uses Client Credentials (app-only — it only searches, and has no refresh token to expire), while `spotify_playlist.py` uses the user-authorized client in `common.get_spotify_user_client()`, because Client Credentials has no user context and **cannot** create or modify a playlist. The latter needs `SPOTIFY_REFRESH_TOKEN` + `SPOTIFY_REDIRECT_URI` on top of the shared client id/secret; `scripts/spotify_oauth_bootstrap.py` is the one-time consent step. Both must use spotipy's `MemoryCacheHandler` — the default `CacheFileHandler` writes a `.cache` token file into the CWD, which is meaningless on a runner with no durable home (G3).

`data/<week>/_playlist.json` must stay committed (`presentation.yml` stages it): it carries the playlist id that makes a re-run reuse the week's playlist instead of creating a duplicate. `spotify_playlist.py` replaces tracks rather than appending, and deliberately has **no** `week_has_already_begun()` guard — that guard protects the attendance signal, which playlists don't carry, so it would only block legitimate backfill re-renders.

`spotify_playlist.py`'s track source is an artist's recent album/single tracks (`artist_albums` → `album_tracks`), not their "top tracks" — `GET /v1/artists/{id}/top-tracks` returned 403 for every artist tested (including a global megastar, under both auth flows) the first time this ran for real, and Spotify's own reference page for it now reads "Deprecated." Search's `track` results lost their `popularity` field in the same window, which is why "search + sort by popularity" isn't the fallback either. If Spotify deprecates `artist_albums`/`album_tracks` too, expect to swap the source again — anything returning track URIs for a known `artist_id` fits the same shape. `collect_track_uris` deliberately does not catch per-artist failures: an exception there means the API call itself is broken (not "this artist has no tracks," which is a normal empty result), so it propagates immediately instead of repeating across every remaining artist.
