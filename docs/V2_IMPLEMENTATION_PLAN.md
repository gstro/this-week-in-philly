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

> **Design pivot (superseding note):** the design moved from Google Drive to GitHub-as-storage — intermediate data, the picks log, and the final report all live in the repo (`data/`, `docs/`); GitHub Actions (`on: push`) replaces the Anthropic-API-driven presentation trigger; GitHub Pages replaces the Drive-hosted report link. This resolves G1, G2, and G6 below by elimination, and replaces G4's email delivery with a stable Pages URL. They're kept struck through for the record rather than deleted outright, since they document *why* the pivot happened.

~~**G1. No Drive download step.** Every script consumes local paths, but v2's data lives in Google Drive. Whatever runs `runner.sh` in the cloud must first pull the week folder down. Add a `drive_sync.py` (download `YYYY-MM-DD/` folder by ID) as step 0 of `runner.sh`.~~
**Resolved by pivot:** data lives in the repo. The GitHub Actions runner already has the pushed `data/YYYY-MM-DD/` from checkout — no download step, no `drive_sync.py`.

~~**G2. The picks-log location contradicts the preferred runner architecture.**~~
**Resolved by pivot:** `data/event-picks-log.csv` is committed to the repo directly by the presentation workflow. No Drive API round-trip.

**G3. OAuth won't survive the cloud as specified.** `credentials.json` + persisted `token.json` at `~/.config/twip/` assumes a durable home directory; Routines and GitHub Actions runners have none. Plan: run the interactive consent flow once locally, then inject client ID/secret/refresh token as Routine environment secrets **and GitHub Actions repo secrets**, with `common.py` reconstructing credentials from env. Scope is Calendar-only now (no Drive, no Gmail). Critical sub-gotcha: a Google Cloud OAuth app left in **Testing** status expires refresh tokens after 7 days — the consent screen must be pushed to **Production** (no verification needed for personal-scope use) or the pipeline dies silently on week two.

~~**G4. No delivery/notification step.**~~
**Resolved by pivot (decision, not fully solved):** delivery is the stable weekly GitHub Pages URL (`docs/weeks/YYYY-MM-DD.html`, linked from `docs/index.html`) — no email. This is a conscious downgrade from "push a link to Greg" to "Greg checks a URL," and it also means the pipeline loses the email channel as a failure-alert mechanism (see G5).

**G5. No failure story for the chain.** If Collection dies, Selection never fires and Sunday passes silently. Without `notify.py` (dropped per G4), mitigations are GitHub-native: (1) GitHub Actions sends a failure email automatically to repo watchers when `presentation.yml` fails — no code needed; (2) Collection/Selection Routine failures surface on the Routines dashboard (claude.ai/code/routines), not via email — check it after a silent Sunday; (3) document a manual re-fire runbook (each Routine is independently triggerable, and `presentation.yml` can be re-run from the Actions tab); (4) optionally give Selection a late-morning fallback cron that no-ops if `_selections.json` already exists and exits loudly if the manifest is missing.

~~**G6. `drive_upload.py` should be idempotent.**~~
**Resolved by pivot:** there is no `drive_upload.py`. `html_render.py` overwrites `docs/weeks/YYYY-MM-DD.html` in place on every run (a plain file write, not an upload) — idempotent by construction.

**G7. Skill files are full of absolute Mac paths.** All four skills (and the v1 task files they'll be adapted from) reference `/Users/molo/...` paths. Migration to `.claude/skills/` requires rewriting every path to repo-relative or env-var form, not just copying files.

**G8 (new). Public repo exposes personal data.** Going public (per design decision) means `data/event-picks-log.csv` (including pre-Philly Austin history) and the `.claude/skills/personal-interests` / `event-selection-philosophy` skill files become world-readable. Accepted tradeoff for a simple Pages setup — but worth a deliberate pass to scrub anything Greg wouldn't want public before flipping the repo visibility, rather than discovering it after the fact.

### Minor

- ~~Pin Routine model IDs at creation time against the then-current model list; `claude-sonnet-4-6` in the design may be superseded (`claude-haiku-4-5` is current for Haiku).~~ **Resolved by Phase 0 spike (2026-07-16):** both dated IDs are stale. Use `claude-haiku-4-5-20251001` for Collection and `claude-sonnet-5` for Selection; re-check at Phase 4 creation time since this may drift again.
- ~~Confirm the Routines cron timezone semantics (UTC vs. local) during the Phase 0 spike — `0 2 * * 0` in UTC is Saturday 9/10 PM ET, which would collect a day early.~~ **Resolved:** the container clock is UTC, and a `run_once_at` trigger set to `2026-07-16T21:57:00Z` fired at `21:57:27Z` — 27 seconds later, no reinterpretation. `run_once_at` and `cron_expression` share documented UTC semantics (per the `schedule` skill), so treat `cron_expression` as UTC with high confidence; a true recurring-cron test wasn't done, but the residual risk is low.
- ~~**Routine environment network access: two spike runs disagreed.**~~ **Resolved:** Run 1 and Run 2 turned out to use two different environments (`env_01Tra3GmJhRh8sn1TLhfJqjy` vs. `env_01J2uP1UzybpQZiUHAZ6v8P2`, confirmed via the trigger's own API record) — the environment's **Network access** level is the controlling variable Run 2's write-up said was missing. Greg confirmed the working environment's level is named **"Full"**, more permissive than the "Trusted" default that likely explains Run 1's blocks. Action: set the Collection (and Selection, if needed) Routine's environment to "Full" network access at Phase 4 creation time. One confirmatory run on the actual Phase 4 environment is still worthwhile, since this pair also showed a routine's `environment_id` can silently differ between edits — worth double-checking which environment is attached. See `docs/PHASE_0_SPIKE.md` for full detail.
- **(new) `git push --delete` is not covered by ambient Routine credentials** (gets `HTTP 403`; no GitHub MCP tool offers branch deletion either), even though `git push` (create/update) works fine via ambient auth with no stored token needed. Any setup script or spike that creates scratch branches must plan for manual/external cleanup.

---

## Part 2 — Open Questions, Resolved

**Q1. HTML rendering: script or Routine? → Script it.**
`events-report-format/SKILL.md` is already a pixel-level spec — exact hex colors, font sizes, markup snippets, fixed category order. That's a Jinja2 template that happens to be written in prose. The parts of the skill that are *not* templatable (verification searches, dedup preferences, blurb tone) belong to Selection anyway, not rendering. Port the spec to `templates/report.html.j2`, validate with a golden-file comparison against a real v1 report, keep the SKILL.md as the human-readable design reference for the template.

**Q2. Chrome connector in Routines? → Spiked (2026-07-16, two runs). Not available; playwright fallback confirmed required and confirmed installable given the right environment setting.**
This was the single biggest unknown and it gates Collection (Tiers 2–5 ≈ 23 of 29 sources... though Tier 4's 8 Meetup feeds are iCal via web_fetch, so effectively ~15 sources). Phase 0's throwaway Routine confirmed `get_page_text` does not exist as a tool in this environment — only `WebFetch` (fetch + small-model summarize, not raw page text) is available, which is not a substitute. The playwright fallback's viability turned out to be environment-dependent, not a fixed platform limitation: Run 1 (environment `env_01Tra3GmJhRh8sn1TLhfJqjy`) found chromium's binary download from `cdn.playwright.dev` rejected; Run 2 (a different environment, `env_01J2uP1UzybpQZiUHAZ6v8P2`) found the full download succeeded. Greg confirmed Run 2's environment has its **Network access** level set to **"Full"** — almost certainly why it worked where Run 1 didn't. **Action for Phase 4: create the Collection Routine's environment with Network access = "Full"**, then re-verify playwright install on that specific environment before relying on it.

**Q3. runner.sh trigger? → GitHub Actions, `on: push`.**
Superseded by the storage pivot. Rather than a third Routine (option a) or Selection running scripts itself (option b), Selection's own `git push` of `_selections.json` is the trigger: `.github/workflows/presentation.yml` runs `on: push` filtered to `data/**/_selections.json`. This is cleaner than any of the three originally-considered options — no extra Routine, no API/webhook plumbing, no Mac dependency — and it's a natural consequence of storing data in the repo rather than Drive. G1 and G2 (drive_sync, CSV-to-Drive) no longer apply.

**Q4. Songkick page cap impact? → Measured. Cap is safe.**
The picks log answers this today: of 84 Philadelphia Top 3 picks logged, exactly **2 came from Songkick (2.4%)**, and only 2 of 136 total logged rows (picks + honorable mentions) are Songkick-sourced. The specialist sources dominate (Iffy Books 14, Do215 12, PhilaMOCA 10, Ask A Punk 6, R5 5 of Top 3 picks). Cap at 4 pages with zero meaningful cost.

---

## Part 3 — Implementation Phases

### Phase 0 — Spike & decide (small; do first, blocks everything cloud-side)

**Status: spike complete (2026-07-16); all findings resolved except deleting the throwaway Routine.** Full detail and raw output in `docs/PHASE_0_SPIKE.md`.

1. Push this repo to GitHub as **public** `this-week-in-philly`; enable GitHub Pages, serving `docs/` on `main` (migration step 1). — **Done and verified live**: `https://gstro.github.io/this-week-in-philly/` serves the placeholder with the expected marker text.
2. **Routine environment spike** — create one throwaway Routine and verify in a single run:
   - Is `get_page_text` / Chrome available? (→ Q2) — **No.** Tool doesn't exist; only `WebFetch` (fetch+summarize) is available. Confirmed on both runs.
   - Can it install playwright via setup script if not? — **Yes, on an environment with "Full" network access** (see below). Run 1's environment (Network access = likely "Trusted") blocked the chromium download; Run 2's environment (confirmed "Full") downloaded it successfully.
   - **Can the Routine `git push` to the repo?** What auth works? — **Yes, via ambient credentials** (a local git relay); no stored token needed. Confirmed on both runs. `git push --delete` is *not* covered by the same ambient auth (403 on both runs) — ref cleanup needs a human or non-sandboxed `git`; four scratch branches across both runs needed manual deletion.
   - Do env vars work, and can bash `curl` an external API? — Env var propagation: confirmed working (Run 1). External `curl`: environment-dependent, resolved by the network-access finding below — reachable with "Full" access.
   - Cron timezone semantics. — **Resolved.** Container clock confirmed UTC; a `run_once_at` timestamp fired 27 seconds after the requested UTC instant, confirming scheduling timestamps aren't reinterpreted.
   - Available model IDs. — Ran as `claude-sonnet-5` both times; no model-list tool exists. Use `claude-haiku-4-5-20251001` (Collection) / `claude-sonnet-5` (Selection) at Phase 4 creation time — the dated IDs in this doc are stale.
   - **(found, not originally listed) Network access — resolved.** It's a per-environment setting, not a fixed platform limitation. Run 1 and Run 2 turned out to run on two different environments (confirmed via the trigger's own API record); the environment with Network access = **"Full"** had unrestricted-enough access for all 7 sampled real source domains and the playwright CDN, while the other (likely "Trusted", the default) blocked both. **Action: set the Collection Routine's environment to "Full" network access at Phase 4 creation time.**
3. **Confirm Pages build** — push a placeholder `docs/index.html` and verify it serves at the expected URL. — **Done.** Verified live at `https://gstro.github.io/this-week-in-philly/` with the `PHASE-0 PLACEHOLDER` marker present.
4. Record answers in this doc — done (see rows/notes above and `docs/PHASE_0_SPIKE.md`, which has full Run 1 vs. Run 2 tables, raw probe output, and the network-access resolution). Chrome is unavailable, so the "playwright extraction notes" task is added to Phase 4 — contingent only on remembering to set "Full" network access on that Routine's environment, not on any unresolved platform question. Routine git-push works via ambient auth, so no GitHub REST API fallback is needed.

**Remaining before Phase 0 can close:**
- Delete the throwaway spike Routine (no API/MCP tool for this — do it at claude.ai/code/routines).
- Optional, low-priority: one confirmatory run on whatever environment Phase 4 will actually use, to remove any doubt about which `environment_id` a new Collection Routine ends up attached to (Run 1 vs. Run 2 showed this isn't always obvious).

**Exit criteria:** every cloud assumption in the design is confirmed or has a chosen fallback.

### Phase 1 — Repo restructure (small)

1. Move `v1/Skills/*` → `.claude/skills/*` (all four; keep `v1/` untouched as the running-system reference until cutover).
2. Rewrite absolute Mac paths in the migrated skills to repo-relative / env-var form (G7).
3. Scaffold `scripts/`, `templates/`, `data/`, `docs/` (with a placeholder `index.html`), `.github/workflows/`, `requirements.txt` (`google-api-python-client`, `google-auth-oauthlib`, `spotipy`, `jinja2` — no Gmail dependency), `README.md`.
4. `.gitignore`: `credentials.json`, `token.json`, `.env`, `__pycache__/`.
5. Confirm repo visibility is public and Pages is enabled (serving `docs/` on `main`) — see G8 for the data-exposure tradeoff this accepts.

**Exit criteria:** repo matches the design's target structure; no secrets committable.

### Phase 2 — Script suite, built and tested locally (the bulk of the work)

Build against an archived week's real data (June 22 per the design's migration step 3). Every script: standalone, CLI args + env vars, `--dry-run` where it mutates external state (calendar, CSV).

Build order (dependency-driven):

| Order | Script | Notes |
|---|---|---|
| 1 | `common.py` | Google (Calendar-only) credentials from env (G3-compatible from day one); week-date math. No Drive/Gmail helpers — data access is plain repo-relative file I/O. |
| 2 | `spotify_lookup.py` | ThreadPoolExecutor; writes `_spotify.json`; no-match → null, never guess |
| 3 | `templates/report.html.j2` + `html_render.py` | Port `events-report-format/SKILL.md` faithfully; writes `docs/weeks/YYYY-MM-DD.html` and updates `docs/index.html` with a link to the new week; **golden test:** render June 22 `_selections.json` and diff structurally against the v1-produced HTML |
| 4 | `csv_log.py` | Idempotent on week+title (per design); price-tier inference from `cost`; reads/writes `data/event-picks-log.csv` directly |
| 5 | `attendance_check.py` | Calendar presence → `attended` true/false for last week's rows in `data/event-picks-log.csv` |
| 6 | `calendar_create.py` | Clears **target** week first (D2); end-time heuristics from v1 (literary +90m, film +2h, concert +3h, festival +6h); up to 21 events (D3) |
| 7 | `runner.sh` | Corrected version below |

There is no `drive_upload.py`, `drive_sync.py`, or `notify.py` — storage is the repo itself, so there's nothing to sync, and delivery is the stable GitHub Pages URL rather than an emailed link (see G4).

Corrected `runner.sh`:

```bash
#!/bin/bash
set -euo pipefail
WEEK_DIR="$1"                                     # data/YYYY-MM-DD — already checked out by the Actions runner
HTML_PATH="docs/weeks/$(basename "$WEEK_DIR").html"  # D1: named per-week, not a single overwritten file

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
python scripts/csv_log.py "$WEEK_DIR" &
CSV_PID=$!
wait "$CAL_PID"; wait "$CSV_PID"

# The calling workflow (presentation.yml) commits and pushes:
#   docs/weeks/*.html, docs/index.html, data/*/_spotify.json, data/event-picks-log.csv
```

`presentation.yml` (new, replaces the old "lightweight Presentation Routine" idea):

```yaml
name: Presentation
on:
  push:
    paths:
      - 'data/**/_selections.json'
jobs:
  present:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r scripts/requirements.txt
      - name: Run presentation pipeline
        env:
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}
          SPOTIFY_CLIENT_ID: ${{ secrets.SPOTIFY_CLIENT_ID }}
          SPOTIFY_CLIENT_SECRET: ${{ secrets.SPOTIFY_CLIENT_SECRET }}
        run: |
          WEEK_DIR=$(dirname "$(git diff --name-only HEAD~1 HEAD -- 'data/**/_selections.json' | head -1)")
          bash scripts/runner.sh "$WEEK_DIR"
      - name: Commit and push report + updated log
        run: |
          git config user.name "twip-bot"
          git config user.email "twip-bot@users.noreply.github.com"
          git add docs/ data/event-picks-log.csv
          git diff --staged --quiet || git commit -m "Publish report for $(date +%F)"
          git push
```

Uses the default `GITHUB_TOKEN` for the push (no extra secret needed) — its commits don't retrigger `on: push` workflows, and the trigger path filter (`_selections.json` only) is untouched by this job anyway, so there's no risk of a loop.

**Exit criteria:** full `runner.sh` run against June 22 data produces an HTML report that matches the v1 report, correct calendar events in a test calendar, and correct CSV rows — all from one command; a real push of a test `_selections.json` fires `presentation.yml` end-to-end and the report appears on the Pages URL.

### Phase 3 — Auth & data layer (one-time setup + one dual-write Sunday)

1. Google Cloud project: enable the **Calendar API only**; OAuth consent screen → **Production** status (G3); run local consent flow; capture refresh token.
2. Spotify developer app; client credentials.
3. Store all secrets as env vars locally, as Routine secrets, and as **GitHub Actions repo secrets**; never in the repo itself.
4. `data/event-picks-log.csv` is created directly in the repo (no migration needed — it was never anywhere else in v2).
5. **Dual-write Sunday** (migration step 4): update the v1 desktop collection task to also commit JSONs to a scratch branch/folder in the repo; verify Selection-readable structure; v1 remains the system of record.

**Exit criteria:** scripts run end-to-end using only env-var auth (no `~/.config` files); one real Sunday's data lands in the repo alongside v1's iCloud copy.

### Phase 4 — Routines + Actions (one per week, in dependency order)

1. **Collection Routine** — Haiku, cron Sunday 2:00 AM ET (timezone per Phase 0 findings), Calendar connector, git push access (per Phase 0 spike), Songkick 4-page cap, Chrome-or-playwright per Phase 0. Run parallel with v1 for one week; diff source JSONs committed to `data/` against v1's iCloud output.
2. **Selection Routine** — Sonnet, API trigger; wire Collection's completion `curl`; verify `_selections.json` is committed and pushed to `data/`; blurb quality check against v1's output for the same week. Add fallback cron + note the GitHub-native failure story (G5) — no custom notify script.
3. **Wire `presentation.yml`** — confirm the `on: push` trigger fires from Selection's real push (not just a manual test push from Phase 2); verify secrets resolve correctly in the Actions environment.

**Exit criteria:** an end-to-end cloud run (Collection → Selection → `presentation.yml`) completes with the Mac closed, and the report is live at the Pages URL.

### Phase 5 — Validation & cutover

1. Run v1 and v2 in full parallel for 1–2 Sundays (separate `data/` week folders / test calendar for v2 to avoid collisions).
2. Compare per stage: source yield vs. v1 collection, Top 3 overlap + blurb quality vs. v1 selection, byte-level report diff (v2's Pages HTML vs. v1's).
3. Check Haiku specifically: did collection JSON quality hold? (This is the model-downgrade risk point; revert Collection to Sonnet if extraction quality slipped.)
4. Decommission the three v1 desktop tasks (migration step 8); note token/cost per session from the Routines dashboard as the v2 baseline.

**Exit criteria:** two consecutive clean cloud Sundays; v1 disabled; `v1/` directory kept in repo as historical reference.

---

## Part 4 — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ~~Routine network access to arbitrary outbound hosts~~ | Resolved | Was potentially critical — all ~29 Collection sources, the playwright CDN, and Collection→Selection curl chaining depend on it | **Resolved (Phase 0 spike, 2026-07-16):** it's a per-environment "Network access" setting, not a fixed platform limit. Run 1 and Run 2 used two different environments (confirmed via the trigger's API record); the one with access level **"Full"** (confirmed by Greg) had unrestricted-enough access, the other (likely "Trusted", the default) blocked it. Mitigation is now a known config step: set the Collection Routine's environment to "Full" network access at Phase 4 creation time. See `docs/PHASE_0_SPIKE.md` for the full Run 1/Run 2 comparison. |
| ~~Chrome unavailable in Routines~~ | Confirmed | High — blocks ~15 sources | **Confirmed unavailable** (Phase 0 spike, both runs, 2026-07-16): `get_page_text` does not exist as a Routine tool; only `WebFetch` (fetch+summarize, not raw text) is available. Playwright fallback is required and **confirmed working** given "Full" network access (see the resolved network-access row above) — full chromium download succeeded on that environment. |
| ~~Routine cannot `git push` to the repo~~ | Resolved | — | **Resolved (Phase 0 spike, confirmed on both runs):** ambient credentials (a local git relay) push successfully with no stored token needed — the GitHub REST contents API fallback is not needed. Caveat: `git push --delete` is NOT covered by ambient auth (`403` on both runs); ref/branch deletion needs manual or external cleanup — four scratch branches across both runs needed manual deletion. |
| Google refresh token expiry (Testing status) | High if unaddressed | High — silent death week 2 | Consent screen to Production in Phase 3 |
| Haiku collection quality regression | Medium | Medium — garbage-in for selection | Parallel-run diff in Phase 5 step 3; revert to Sonnet is a one-line change |
| API chaining (Collection → Selection) not supported as designed | Low — network-access blocker that would have caused this is resolved | Medium | The `curl` call to fire Selection wasn't directly tested on either run, but the underlying network-access question that would have blocked it is resolved (see above) — a `curl` from a "Full"-access environment should work. Get one confirmatory test in Phase 4 before relying on it; fallback remains scheduled Selection with a manifest-existence guard if it's still unsupported. |
| Template drift vs. desired report look | Low | Low — Q1 analysis shows spec is stable | Golden test in Phase 2; SKILL.md retained as spec of record |
| Silent Sunday failure | Medium | Medium | GitHub Actions failure email (presentation) + Routines dashboard checks (Collection/Selection) + fallback cron (G5) — no custom notify script |
| Public repo exposes picks log + interest profile | Certain (accepted) | Low–Medium — personal data, not credentials | G8: deliberate scrub pass before flipping repo public in Phase 0/1 |

---

## Part 5 — Suggested Order of Attack

Phase 0 and Phase 2 are independent — the spike can run while scripts are being built, since scripts are testable entirely locally. Phase 1 is an afternoon. The critical path is **Phase 0 → Phase 3 → Phase 4 → Phase 5** because each depends on cloud facts or real Sundays. Realistic calendar time: **4–5 weeks**, dominated by the one-Sunday-per-validation cadence, not by build effort.

The GitHub pivot shrinks the build itself relative to the original Drive-based design: three scripts are gone entirely (`drive_sync.py`, `drive_upload.py`, `notify.py`), there's no Drive OAuth scope to provision, and the trigger mechanism (Open Question 3) is answered by a standard `on: push` workflow instead of a bespoke third Routine. The remaining unknowns are narrower and now center on one new question — whether a Routine can push to a git repo — rather than a Drive API integration surface.
