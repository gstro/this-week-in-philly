# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An automated weekly events-curation pipeline for Philadelphia: every Sunday it collects roughly 500–1000 raw events from ~22 sources (the range moves with Do215's own volume week to week — see `data/*/_manifest.json`), narrows them to a published report of Top 3 picks per day against Greg's interests, and delivers an HTML report plus Google Calendar entries. (v1's original "~245 events from ~29 sources" is long out of date — `docs/TOKEN_OPTIMIZATION.md` flagged this itself before going stale in the same way.)

**Current state: v2 is live in production**, running on GitHub Actions since Phase 5 of `docs/V2_IMPLEMENTATION_PLAN.md`. The `scripts/` suite, its test suite, and an in-progress TypeScript port (`src/`) all exist and run in CI — see **Commands** below. `docs/v1/` remains as reference only; it does not describe what's currently running (see **Pipeline architecture**).

## Where things are

- `scripts/` — the production Python pipeline (Collection, Selection's merge/report/calendar/Spotify steps, all of Presentation). Each script is standalone with its own CLI; `scripts/common.py` holds shared constants/helpers.
- `templates/` — the Jinja2 templates `scripts/html_render.py` renders (`report.html.j2`, `index.html.j2`); `templates/report.html.j2`'s own comments are the current spec for report layout, colour, and responsive behaviour.
- `tests/` — pytest suite mirroring `scripts/`, plus `tests/golden/` (a byte-pinned real-output fixture) and `tests/fixtures/`.
- `src/` — an in-progress TypeScript port of select `scripts/*.py` modules (`common`, `mergeSelections`, `prepareSelectionInput`, `checkSelection` so far). Not yet wired into any workflow or production path — the `.py` originals are still what actually runs; see **Commands** for how to exercise this side independently.
- `.claude/skills/` — the domain-knowledge skills genuinely read by the one live Routine (Selection): `philly-events-selection`, `personal-interests`, `event-selection-philosophy`. `philadelphia-sources` and `events-report-format` used to live here too, documenting Collection's and Presentation's old Routine-driven behavior; both were **deleted** once neither stage loaded them at runtime any more (see **Pipeline architecture**'s corollary) — per-source knowledge now lives in each `scripts/event_parsers/*.py` module's own docstring (depth varies — `collect_week.py`'s own comment names which ones inherited real quirks/rationale vs. a one-line tech-shape description), and the report format spec is `templates/report.html.j2`'s own comments. Their frozen `docs/v1/Skills/` counterparts remain as historical reference only, pointing at those replacements.
- `.github/workflows/` — `collection.yml` and `presentation.yml` are the two production pipelines (see **Pipeline architecture**); `collection-check.yml` and `lint.yml` are CI guards, the latter Python-only (see **Commands**).
- `data/<week>/` — each week's committed pipeline artifacts (`_manifest.json`, `_candidates.json`/`_candidates/`, `_selections.json`, `_spotify.json`, `_playlist.json`). `docs/weeks/<week>.html` is the corresponding published report; `docs/index.html` is regenerated from `docs/weeks/*.html` on every render.
- `docs/*.md` (this level, not `v1/`) — design docs and investigation write-ups, several still cited as living rationale for code in `scripts/` (e.g. `COLLECTION_PROXY_ISSUE.md`, `COLLECTION_YIELD_INVESTIGATION.md`). Status banners on the older ones note what's since shipped.
- `docs/V2_DESIGN.md` — the v2 architecture (cloud Routines + Python scripts). Historical design record now that v2 is the running system; see its status banner.
- `docs/V2_IMPLEMENTATION_PLAN.md` — the build plan; includes design-review corrections that **supersede the design doc where they conflict** (e.g., the runner.sh sketch in the design has known bugs; the plan has the corrected version). Also historical at this point — see its status banner.
- `docs/v1/` — snapshot of the v1 system that ran on Greg's Mac via desktop scheduled tasks, before the cutover to v2. Reference material only; changing these files does not change the running system.
  - `Scheduled/*/SKILL.md` — the three v1 task definitions (collection, selection, presentation)
  - `Skills/*/SKILL.md` — the four domain skills (sources, interests, selection philosophy, report format) — each carries a "frozen v1 snapshot" banner pointing at its live `.claude/skills/` counterpart
  - `Data/event-picks-log.csv` — historical picks log (includes pre-Philly Austin rows)

## Commands

Python (`scripts/`, `tests/`) — CI-enforced on every push/PR touching them (`lint.yml`):
- `pytest` — the offline suite (default; network/live-source integration tests are excluded and run manually only via `pytest -m network`)
- `ruff check scripts/`
- `mypy` (needs `scripts/requirements-dev.txt` + `scripts/requirements-collection.txt` installed — `mypy` type-checks `fetch_page_text.py`'s playwright import even though nothing launches a browser)

Use a venv with `scripts/requirements.txt` (+ `-collection.txt` for anything touching Playwright/browser-fetch code, `-dev.txt` for ruff/mypy/pytest itself) — there's no committed `.venv/`, set one up locally.

TypeScript (`src/`) — **not** CI-enforced; run manually:
- `npm test` (vitest)
- `npm run lint` (eslint)
- `npm run typecheck` / `npm run build` (tsc)

## Pipeline architecture

Three stages, chained by file handoffs. This structure is the same in v1 and v2; only the infrastructure changes. v1: three Mac scheduled tasks passing files through iCloud. **v2, as originally designed, ran Collection and Selection as two Claude Code Routines — that is now stale.** `scripts/collect_week.py`'s own docstring states it plainly: "Runs a full Collection pass for one week, deterministically, with no model. This is the GitHub Actions replacement for the Collection Routine." `.github/workflows/collection.yml` runs it as a plain script step (per-source parsers in `scripts/event_parsers/`), then fires **Selection's** Routine via its API trigger (`SELECTION_ROUTINE_ID`/`SELECTION_ROUTINE_TOKEN`, the "Trigger Selection routine" step) the moment collection data lands on `main` — Selection's own fixed cron stays as a fallback. Selection is the only stage still running as an actual Claude Code Routine; GitHub Actions runs the Python script suite for everything else (Collection, and everything after Selection writes its annotations), with GitHub Pages serving the report.

```
Collection   → per-source JSONs + _manifest.json        (~22 sources, tier-ordered cheapest-first; scripted)
Selection    → _selection_annotations.json              (dedupe, score, Top 3/day, write "why" blurbs; the one Routine)
Presentation → _selections.json, HTML report, Calendar  (deterministic; v2 scripts this entirely -- CSV logging is inert, see Key contracts)
```

Tasks are deliberately thin; all domain logic lives in the skill files. Selection is the only stage that generates prose (the `why` blurbs) — that's why it's the only one still worth a model at all: Collection and Presentation now cost zero model tokens, not just cheaper ones.

**Corollary:** `.claude/skills/philadelphia-sources/SKILL.md` and `.claude/skills/events-report-format/SKILL.md` (see the HTML report spec bullet below) were no longer loaded by any Routine at runtime, so both have been **deleted** — `collect_source.py`, `collect_week.py`, and `scripts/event_parsers/*.py` had only cited the former in comments for per-source provenance (now moved into each parser module's own docstring); `templates/report.html.j2`'s own comments are the report spec now. `philly-events-selection`, `personal-interests`, and `event-selection-philosophy` remain genuinely consumed, since Selection is still the one live Routine reading skills.

## Key contracts (change with care)

- **`_selections.json` schema** — the interface between Selection and everything downstream. Defined with a full example in `docs/v1/Scheduled/philly-events-selection/SKILL.md` (v1 original, unchanged) and `.claude/skills/philly-events-selection/SKILL.md` (v2's Selection Routine task, adapted for repo-relative paths and `scripts/prepare_selection_input.py`'s pre-deduped `_candidates.json` input — same schema, same nine canonical `category` strings). The nine `category` strings are canonical (emoji included, exact match).
- **HTML report spec** — `docs/v1/Skills/events-report-format/SKILL.md` is a pixel-level spec (exact colors, sizes, markup) from v1, kept as frozen historical reference. Its v2 counterpart, `.claude/skills/events-report-format/SKILL.md`, has been deleted — nothing loaded it at runtime, since Presentation is fully scripted. `templates/report.html.j2`'s own comments are the spec of record now.
- **Picks log columns** — `city, week_of, day, date, title, venue, category, source, rank, price_tier, spotify_link, tags, attended`. `csv_log.py` must stay idempotent on week+title.
- **Week window convention** — every stage covers the Monday immediately following the run date through the Sunday after (computed at runtime, never hardcoded).
- **Attendance feedback loop** — Greg deletes Curated Events calendar entries he didn't attend; presence at week's end means attended. As designed (`attendance_check.py`, v1's "Step 0" concept — there's no equivalent numbered step in the scripted `collect_week.py`), this gets written back to the picks-log CSV — **currently inert**, since `attendance_check.py`/`csv_log.py` are shelved out of `runner.sh`, as the end of this bullet notes. The calendar-write guard below applies regardless of that: `calendar_create.py` must clear only the *target* (upcoming) week, never a week that has already started. Enforced, not just documented: `calendar_create.py`'s `week_has_already_begun()` skips the Calendar write entirely when the target week's Monday is in the past (Eastern), prints why, and exits 0 so the report still renders and publishes. `--force-calendar` overrides. This exists because merging PR #26 pushed a backfill to a *historical* week's `_selection_annotations.json`, which matches `presentation.yml`'s path filter and fired Presentation against the week of 2026-08-17 after it had ended — wiping and recreating all 21 entries and destroying that week's attendance signal. **`data/2026-08-17`'s calendar week is knowingly wrong** and was accepted as lost; no CSV was affected, since `attendance_check.py`/`csv_log.py` are shelved out of `runner.sh`.

## Script conventions

Per the implementation plan: scripts live in `scripts/`, each standalone with CLI args + env-var config, `--dry-run` on anything that mutates external state (Calendar, Drive, CSV — Drive is no longer in scope, see `V2_IMPLEMENTATION_PLAN.md` G7, but the flag naming predates that cut). Google auth is built from env vars from day one (`credentials.json`/`token.json` never live in the repo) — the actor that made this necessary is GitHub Actions' ephemeral runners for everything except Selection now, not Routines generally, but the constraint (no durable home dir) is the same either way. `runner.sh` orchestrates: attendance_check must complete before csv_log (shared CSV); spotify_lookup → spotify_playlist → html_render (the playlist needs lookup's `_spotify.json` artist matches; the report header needs the playlist's `_playlist.json` URL).

Two distinct Spotify auth flows, deliberately: `spotify_lookup.py` uses Client Credentials (app-only — it only searches, and has no refresh token to expire), while `spotify_playlist.py` uses the user-authorized client in `common.get_spotify_user_client()`, because Client Credentials has no user context and **cannot** create or modify a playlist. The latter needs `SPOTIFY_REFRESH_TOKEN` + `SPOTIFY_REDIRECT_URI` on top of the shared client id/secret; `scripts/spotify_oauth_bootstrap.py` is the one-time consent step. Both must use spotipy's `MemoryCacheHandler` — the default `CacheFileHandler` writes a `.cache` token file into the CWD, which is meaningless on a runner with no durable home (G3).

`data/<week>/_playlist.json` must stay committed (`presentation.yml` stages it): it carries the playlist id that makes a re-run reuse the week's playlist instead of creating a duplicate. `spotify_playlist.py` replaces tracks rather than appending, and deliberately has **no** `week_has_already_begun()` guard — that guard protects the attendance signal, which playlists don't carry, so it would only block legitimate backfill re-renders.

`spotify_playlist.py`'s track source is an artist's recent album/single tracks (`artist_albums` → `album_tracks`), not their "top tracks" — `GET /v1/artists/{id}/top-tracks` returned 403 for every artist tested (including a global megastar, under both auth flows) the first time this ran for real, and Spotify's own reference page for it now reads "Deprecated." Search's `track` results lost their `popularity` field in the same window, which is why "search + sort by popularity" isn't the fallback either. If Spotify deprecates `artist_albums`/`album_tracks` too, expect to swap the source again — anything returning track URIs for a known `artist_id` fits the same shape. `collect_track_uris` deliberately does not catch per-artist failures: an exception there means the API call itself is broken (not "this artist has no tracks," which is a normal empty result), so it propagates immediately instead of repeating across every remaining artist.
