# This Week in Philly — v2 Design Doc

**Status:** Implemented — this design shipped and is the system currently running in production (see `CLAUDE.md`'s Pipeline architecture for what's actually live, including where reality has since diverged from this doc — Collection is no longer a Routine, for one). Kept as the historical record of the original design and rationale, and because `V2_IMPLEMENTATION_PLAN.md` cites it as the doc it supersedes on conflict.
**Scope:** Full pipeline redesign — cloud infrastructure, code extraction, model optimization

---

## Summary

v1 is a three-session desktop pipeline that runs locally every Sunday morning. It works, but it requires the Mac to be on, burns tokens on deterministic tasks that don't need Claude, and provides no per-task cost visibility.

v2 has three goals:

1. **Move to cloud** so the pipeline runs whether or not the Mac is on
2. **Extract deterministic work to code** so Claude only touches judgment tasks
3. **Optimize models** so the two remaining Claude sessions use the cheapest model that produces acceptable output

The result is two Claude Code Routines (Collection and Selection) plus a Python script suite that handles everything after `_selections.json` is written. All intermediate data, the picks log, and the final report live **in the GitHub repo** — there is no separate cloud storage service. GitHub Actions reacts to repo pushes to drive the presentation stage, and GitHub Pages serves the report.

---

## v1 vs v2

| | v1 | v2 |
|---|---|---|
| Infrastructure | Mac desktop scheduled tasks | Claude Code Routines (cloud) + GitHub Actions |
| Intermediate storage | iCloud folder | GitHub repo (`data/`, via git) |
| Skill files | Local `~/Documents/Claude/Skills/` | GitHub repo `.claude/skills/` |
| Collection model | Sonnet | Haiku |
| Selection model | Sonnet | Sonnet |
| Presentation | Claude session | Python scripts (GitHub Actions) |
| Spotify lookup | Claude (Sonnet) | `spotify_lookup.py` |
| Calendar creation | Claude (Sonnet) | `calendar_create.py` |
| Report publishing | Claude session → local file | GitHub Pages (`docs/`), auto-built on push |
| CSV logging | Claude (Sonnet) | `csv_log.py` |
| Attendance check | Claude (Sonnet) | `attendance_check.py` |
| HTML rendering | Claude (Sonnet) | TBD (see Open Questions) |
| Runs if Mac is closed | No | Yes |
| Per-session token visibility | No | Via claude.ai/code/routines |

---

## Architecture

```
[Sunday 2:00 AM]
        │
        ▼
┌─────────────────────────┐
│  Collection Routine     │  model: Haiku
│  (Claude Code, cloud)   │  trigger: cron 0 2 * * 0
│                         │
│  • Attendance check     │  reads: Google Calendar
│  • Scrape 29 sources    │  reads: .claude/skills/philadelphia-sources
│  • Write source JSONs   │  writes: data/YYYY-MM-DD/*.json (repo)
│  • Write _manifest.json │  writes: data/YYYY-MM-DD/_manifest.json (repo)
│  • git commit + push    │  data is the commit; git is the bus, not Drive
└──────────┬──────────────┘
           │ API trigger (curl, on completion)
           ▼
┌─────────────────────────┐
│  Selection Routine      │  model: Sonnet
│  (Claude Code, cloud)   │  trigger: API (from Collection)
│                         │
│  • Load source JSONs    │  reads: data/YYYY-MM-DD/*.json (repo clone)
│  • Deduplicate          │  reads: .claude/skills/personal-interests
│  • Score + rank         │  reads: .claude/skills/event-selection-philosophy
│  • Write why blurbs     │  writes: data/YYYY-MM-DD/_selections.json
│  • git commit + push    │  this push is what fires the next stage
└──────────┬──────────────┘
           │ GitHub Actions: on push, path data/**/_selections.json
           ▼
┌─────────────────────────┐
│  presentation.yml       │  GitHub Actions workflow (Python scripts)
│  (Python scripts)       │
│                         │
│  1. attendance_check.py │  reads: Google Calendar → updates data/event-picks-log.csv
│  2. spotify_lookup.py   │  reads: _selections.json → writes _spotify.json
│  3. html_render.py      │  reads: _selections.json + _spotify.json → writes docs/weeks/YYYY-MM-DD.html
│  4. calendar_create.py  │  reads: _selections.json + _spotify.json → up to 21 events
│     csv_log.py       ┘  │  reads: _selections.json → appends to picks log
│  5. git commit + push   │  report HTML, _spotify.json, updated picks log
└──────────┬──────────────┘
           │
           ▼
   GitHub Pages (serves /docs on main) → stable weekly URL

Steps 4 run in parallel after steps 1–3 complete.
attendance_check.py must complete before csv_log.py (shared file).
```

**Loop safety:** the presentation workflow pushes using the default `GITHUB_TOKEN`, whose commits do not re-trigger `on: push` workflows in GitHub Actions. The trigger is also path-filtered to `_selections.json`, which the presentation workflow never writes. Both independently prevent the push-triggers-itself loop.

---

## Data Layer

### Intermediate storage: iCloud → in-repo (git)

v1 passes data between tasks via the iCloud folder at `~/Library/Mobile Documents/com~apple~CloudDocs/philly-events/`. Routines can't access iCloud, and Routines can't access a Mac-only volume either — but they can clone and push to a git repo, which is already required infrastructure (skill files already live there). v2 uses the repo itself as the data bus: each stage commits its output and pushes; the next stage's Routine clones the repo and reads the commit. No separate storage service.

| v1 path | v2 path (in repo) |
|---|---|
| `~/...iCloud/philly-events/YYYY-MM-DD/` | `data/YYYY-MM-DD/` |
| `event-picks-log.csv` (local) | `data/event-picks-log.csv` (repo, committed by the presentation workflow) |
| HTML output → local file | `docs/weeks/YYYY-MM-DD.html` (repo, served by GitHub Pages) + `docs/index.html` (landing page, lists weeks) |

`data/event-picks-log.csv` is committed straight to the repo by the presentation workflow's final step — no download/mutate/re-upload round-trip, since git already gives read-modify-write-with-history for free.

### Skill files: local → GitHub repo

Routines clone a GitHub repo at session start. All skill files must be committed there.

| v1 location | v2 location in repo |
|---|---|
| `~/Documents/Claude/Skills/philadelphia-sources/SKILL.md` | `.claude/skills/philadelphia-sources/SKILL.md` |
| `~/Documents/Claude/Skills/personal-interests/SKILL.md` | `.claude/skills/personal-interests/SKILL.md` |
| `~/Documents/Claude/Skills/event-selection-philosophy/SKILL.md` | `.claude/skills/event-selection-philosophy/SKILL.md` |
| `~/Documents/Claude/Skills/events-report-format/SKILL.md` | `.claude/skills/events-report-format/SKILL.md` (or `templates/report.html.j2` if rendering is scripted) |

---

## Collection Routine

**Model:** `claude-haiku-4-5`  
**Trigger:** Schedule — `0 2 * * 0` (Sunday 2:00 AM ET)  
**Repo:** `this-week-in-philly` (GitHub)  
**Connectors:** Google Calendar  

### What changes from v1

- **Model:** Haiku instead of Sonnet. Collection is pure structured extraction — fetch a page, emit JSON. No prose generation.
- **Storage:** Writes source JSONs to `data/YYYY-MM-DD/` in the repo instead of iCloud, then `git add`, `commit`, `push`.
- **Attendance check:** Still runs as Step 0, still uses Google Calendar connector.
- **Songkick pagination:** Hard cap at 4 pages (new). Tradeoff accepted — Tier 1–3 sources cover the high-alignment events; Songkick is a broad sweep.
- **Chrome sources:** See Open Questions. Sources that require `get_page_text` may need playwright in the setup script if Chrome connector isn't available in Routines.
- **Git push auth:** The Routine needs write access to the repo to push `data/`. Options: Claude GitHub App with write permission (if Routines support it), or a deploy key / fine-grained PAT stored as a Routine secret. Confirm which is available — Phase 0 spike item.
- **Chaining:** On completion, fires the Selection Routine's API endpoint via bash (`curl`). The API URL and token live in environment variables. (Unchanged from the Drive-based design — chaining is orthogonal to storage.)

### Environment variables

```
SELECTION_ROUTINE_URL=https://api.anthropic.com/v1/claude_code/routines/trig_.../fire
SELECTION_ROUTINE_TOKEN=sk-ant-oat01-...
GITHUB_PUSH_TOKEN=...             # deploy key or PAT, if not using the GitHub App
```

---

## Selection Routine

**Model:** `claude-sonnet-4-6`  
**Trigger:** API (fired by Collection Routine on completion)  
**Repo:** `this-week-in-philly`  
**Connectors:** none required (git clone/push only)  

### What changes from v1

- **Trigger:** API instead of schedule. No longer depends on a fixed 2-hour gap after collection — fires as soon as collection writes the manifest.
- **Input:** Reads source JSONs from the repo clone (`data/YYYY-MM-DD/*.json`) instead of iCloud — the Routine clones the repo at session start, which already includes Collection's push.
- **Output:** Writes `_selections.json` to `data/YYYY-MM-DD/`, then `git add`, `commit`, `push`. Same auth note as Collection (GitHub App write or deploy key/PAT).
- **No Spotify, no rendering:** Selection ends at `_selections.json`. No scope creep into presentation tasks.
- **Chaining:** Its push *is* the trigger for the next stage — GitHub Actions' `presentation.yml` runs `on: push` filtered to `data/**/_selections.json`. No API call, no webhook, no third Routine.

### Why Sonnet stays here

The selection task writes the `why` blurbs — 2–3 sentence editorial descriptions of why each event is worth attending. This is the only prose generation in the pipeline and the primary output Greg interacts with. Haiku was tested and produced noticeably weaker blurbs.

---

## Script Suite

All scripts live in `scripts/` in the repo. Each is standalone, testable, and accepts paths via CLI args or environment variables — all paths are repo-relative (`data/`, `docs/`). Auth uses Google OAuth 2.0 (Calendar only), credentials reconstructed from env vars/GitHub Actions secrets (Routines and Actions runners have no durable home directory).

| Script | Input | Output | Notes |
|---|---|---|---|
| `attendance_check.py` | Google Calendar, `data/event-picks-log.csv` | Updated `data/event-picks-log.csv` | Must run before `csv_log.py` |
| `spotify_lookup.py` | `_selections.json` | `_spotify.json` | Concurrent lookups via ThreadPoolExecutor |
| `html_render.py` | `_selections.json`, `_spotify.json` | `docs/weeks/YYYY-MM-DD.html` + updates `docs/index.html` | Jinja2 template (see Open Questions) |
| `calendar_create.py` | `_selections.json`, `_spotify.json` | Up to 21 Google Calendar events | Clears target (upcoming) week's picks first |
| `csv_log.py` | `_selections.json`, `_spotify.json` | Appended rows in `data/event-picks-log.csv` | Idempotent (skips existing week+title) |

There is no `drive_upload.py` or `drive_sync.py` — the presentation workflow's own `git commit`/`push` step is the publish step, and GitHub Pages rebuilds automatically from `docs/` on `main`.

### runner.sh execution order

Invoked by `.github/workflows/presentation.yml` (`on: push`, paths: `data/**/_selections.json`), not fired by API call.

```bash
#!/bin/bash
set -euo pipefail
WEEK_DIR="$1"                        # data/YYYY-MM-DD, already present from the push
HTML_PATH="docs/weeks/$(basename "$WEEK_DIR").html"

# Step 1: must complete before csv_log
python scripts/attendance_check.py --week-dir "$WEEK_DIR" &
ATTEND_PID=$!

# Step 2: runs concurrently
python scripts/spotify_lookup.py "$WEEK_DIR" &
SPOTIFY_PID=$!

wait "$ATTEND_PID"; wait "$SPOTIFY_PID"

# Step 3: depends on spotify_lookup
python scripts/html_render.py "$WEEK_DIR" "$HTML_PATH"

# Steps 4-5: parallel, both depend on prior steps
python scripts/calendar_create.py "$WEEK_DIR" &
python scripts/csv_log.py "$WEEK_DIR" &
wait

# The workflow (not this script) commits and pushes docs/ and data/event-picks-log.csv
```

---

## Repo Structure

```
this-week-in-philly/
├── .claude/
│   └── skills/
│       ├── philadelphia-sources/
│       │   └── SKILL.md
│       ├── personal-interests/
│       │   └── SKILL.md
│       ├── event-selection-philosophy/
│       │   └── SKILL.md
│       └── events-report-format/
│           └── SKILL.md          ← or removed if rendering is scripted
├── .github/
│   └── workflows/
│       └── presentation.yml      ← on: push, paths: data/**/_selections.json
├── data/
│   ├── YYYY-MM-DD/                (per-week source JSONs, _manifest.json, _selections.json, _spotify.json)
│   └── event-picks-log.csv
├── docs/                          ← served by GitHub Pages
│   ├── index.html                (landing page: list of weeks)
│   └── weeks/
│       └── YYYY-MM-DD.html        (one report per week)
├── scripts/
│   ├── attendance_check.py
│   ├── spotify_lookup.py
│   ├── html_render.py
│   ├── calendar_create.py
│   ├── csv_log.py
│   ├── runner.sh
│   └── requirements.txt
├── templates/
│   └── report.html.j2            ← Jinja2 template (if rendering is scripted)
└── README.md
```

---

## Auth & Prerequisites

| Service | Method | One-time setup |
|---|---|---|
| Google Calendar | OAuth 2.0 (`google-api-python-client`) | Enable Calendar API in Cloud Console; run local consent flow once; push app to Production status (refresh tokens otherwise expire in 7 days) |
| Spotify | Client credentials (`spotipy`) | Create app at developer.spotify.com; copy client ID + secret |
| GitHub | Existing `gh` auth, Claude GitHub App, or deploy key/PAT | Repo must be **public** (Pages access control on private repos needs GitHub Enterprise); required for both Routine pushes and Actions |
| GitHub Pages | Repo Settings → Pages | Serve from `docs/` on `main` |
| GitHub Actions secrets | Repo Settings → Secrets | Google client ID/secret/refresh token, Spotify client ID/secret, Anthropic Routine token (for Collection→Selection chaining) |

Google is Calendar-only in v2 — no Drive, no Gmail. Credentials are reconstructed from env vars/secrets at runtime; there is no persisted `credentials.json`/`token.json` on disk (Routines and Actions runners have no durable home directory).

Environment variables for scripts:
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
PICKS_LOG_PATH=data/event-picks-log.csv   # repo-relative
```

---

## Migration Path

Sequenced to keep v1 running throughout:

1. **Create GitHub repo** — `this-week-in-philly`, **public**; enable GitHub Pages serving `docs/` on `main`
2. **Move skill files into repo** — commit all four `.claude/skills/` files; keep local copies as backup
3. **Build and test scripts** — run Agent Teams prompt against June 22 data; verify output matches v1 presentation task; complete Google (Calendar-only) OAuth and Spotify setup
4. **Wire `presentation.yml`** — GitHub Actions workflow triggered `on: push` to `data/**/_selections.json`; verify it fires on a manual push of a test `_selections.json`
5. **Create Collection Routine** — configure with Haiku, schedule trigger, Calendar connector, git push access, Songkick page cap; run in parallel with v1 desktop task for one week, comparing `data/` commits against v1's iCloud output
6. **Create Selection Routine** — configure with Sonnet, API trigger; wire Collection → Selection API call; verify `_selections.json` lands in `data/` via git push and that the push fires `presentation.yml`
7. **Confirm runner.sh** — full run end-to-end inside the Actions workflow against a repo-committed `_selections.json`; check Pages serves the resulting report
8. **Decommission desktop tasks** — disable all three v1 scheduled tasks

Each step is independently reversible until step 8.

---

## Open Questions

**1. HTML rendering: script or Routine?**  
`html_render.py` (Jinja2 template) would eliminate the last Claude session from presentation entirely. The blocker is whether `events-report-format/SKILL.md` is stable enough to encode as a template — if the HTML structure changes often, a template requires maintenance on every change vs. Claude adapting automatically. Decision: read `events-report-format/SKILL.md` and assess stability before committing.

**2. Chrome connector in Routines**  
Tier 2–5 collection sources use `get_page_text` (Claude in Chrome). If the Chrome connector isn't available as a claude.ai connector for Routines, these sources would need playwright installed via setup script. Tier 1 sources (web_fetch, iCal, gcal) are unaffected and cover the highest-alignment picks. Decision: test Chrome connector availability in a Routine before migration; if unavailable, install playwright and update per-source extraction notes in `philadelphia-sources/SKILL.md`.

**3. Songkick page cap impact**  
Capping at 4 pages reduces coverage for events late in the week (Thursday–Sunday) that fall on pages 5+. Actual impact unknown — the v1 session transcripts would show which Top 3 picks came from Songkick vs. other sources. If Songkick picks are rare in Top 3, the cap costs nothing meaningful.

~~**Old Q3. runner.sh trigger mechanism**~~ — resolved by moving to GitHub. Selection Routine's `git push` of `_selections.json` is itself the trigger: `presentation.yml` runs `on: push` filtered to `data/**/_selections.json`. No third Routine, no webhook, no dependency on the Mac being on.
