# This Week in Philly — v2 Design Doc

**Status:** Draft  
**Scope:** Full pipeline redesign — cloud infrastructure, code extraction, model optimization

---

## Summary

v1 is a three-session desktop pipeline that runs locally every Sunday morning. It works, but it requires the Mac to be on, burns tokens on deterministic tasks that don't need Claude, and provides no per-task cost visibility.

v2 has three goals:

1. **Move to cloud** so the pipeline runs whether or not the Mac is on
2. **Extract deterministic work to code** so Claude only touches judgment tasks
3. **Optimize models** so the two remaining Claude sessions use the cheapest model that produces acceptable output

The result is two Claude Code Routines (Collection and Selection) plus a Python script suite that handles everything after `_selections.json` is written.

---

## v1 vs v2

| | v1 | v2 |
|---|---|---|
| Infrastructure | Mac desktop scheduled tasks | Claude Code Routines (cloud) |
| Intermediate storage | iCloud folder | Google Drive |
| Skill files | Local `~/Documents/Claude/Skills/` | GitHub repo `.claude/skills/` |
| Collection model | Sonnet | Haiku |
| Selection model | Sonnet | Sonnet |
| Presentation | Claude session | Python scripts |
| Spotify lookup | Claude (Sonnet) | `spotify_lookup.py` |
| Calendar creation | Claude (Sonnet) | `calendar_create.py` |
| Drive upload | Claude (Sonnet) | `drive_upload.py` |
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
│  • Write source JSONs   │  writes: Google Drive /YYYY-MM-DD/*.json
│  • Write _manifest.json │  writes: Google Drive /YYYY-MM-DD/_manifest.json
└──────────┬──────────────┘
           │ API trigger (on completion)
           ▼
┌─────────────────────────┐
│  Selection Routine      │  model: Sonnet
│  (Claude Code, cloud)   │  trigger: API (from Collection)
│                         │
│  • Load source JSONs    │  reads: Google Drive /YYYY-MM-DD/*.json
│  • Deduplicate          │  reads: .claude/skills/personal-interests
│  • Score + rank         │  reads: .claude/skills/event-selection-philosophy
│  • Write why blurbs     │  writes: Google Drive /YYYY-MM-DD/_selections.json
│  • Write _selections    │  triggers: runner.sh (via API or post-hook)
└──────────┬──────────────┘
           │ API trigger (on completion)
           ▼
┌─────────────────────────┐
│  runner.sh              │  runs locally or as lightweight Routine
│  (Python scripts)       │
│                         │
│  1. attendance_check.py │  reads: Google Calendar → updates event-picks-log.csv
│  2. spotify_lookup.py   │  reads: _selections.json → writes _spotify.json
│  3. html_render.py      │  reads: _selections.json + _spotify.json → writes HTML
│  4. calendar_create.py  │  reads: _selections.json + _spotify.json → 21 events
│     drive_upload.py  ┘  │  reads: HTML → uploads to Drive
│     csv_log.py       ┘  │  reads: _selections.json → appends to picks log
└─────────────────────────┘

Steps 4–6 run in parallel after steps 1–3 complete.
attendance_check.py must complete before csv_log.py (shared file).
```

---

## Data Layer

### Intermediate storage: iCloud → Google Drive

v1 passes data between tasks via the iCloud folder at `~/Library/Mobile Documents/com~apple~CloudDocs/philly-events/`. Routines can't access iCloud. v2 uses Google Drive, which is already connected as a MCP connector and already receives the final HTML output.

| v1 path | v2 path |
|---|---|
| `~/...iCloud/philly-events/YYYY-MM-DD/` | Google Drive `This Week in Philadelphia/YYYY-MM-DD/` |
| `event-picks-log.csv` (local) | `~/Documents/Claude/Data/event-picks-log.csv` (local, script-managed) |
| HTML output → Drive | unchanged |

The `event-picks-log.csv` stays local for now — it's only touched by scripts that run locally. If runner.sh moves to a Routine later, this would also migrate to Drive.

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
**Connectors:** Google Drive, Google Calendar  

### What changes from v1

- **Model:** Haiku instead of Sonnet. Collection is pure structured extraction — fetch a page, emit JSON. No prose generation.
- **Storage:** Writes source JSONs to Drive instead of iCloud.
- **Attendance check:** Still runs as Step 0, still uses Google Calendar connector.
- **Songkick pagination:** Hard cap at 4 pages (new). Tradeoff accepted — Tier 1–3 sources cover the high-alignment events; Songkick is a broad sweep.
- **Chrome sources:** See Open Questions. Sources that require `get_page_text` may need playwright in the setup script if Chrome connector isn't available in Routines.
- **Chaining:** On completion, fires the Selection Routine's API endpoint via bash (`curl`). The API URL and token live in environment variables.

### Environment variables

```
SELECTION_ROUTINE_URL=https://api.anthropic.com/v1/claude_code/routines/trig_.../fire
SELECTION_ROUTINE_TOKEN=sk-ant-oat01-...
GOOGLE_DRIVE_WEEK_FOLDER_ID=...   # ID of the "This Week in Philadelphia" parent folder
```

---

## Selection Routine

**Model:** `claude-sonnet-4-6`  
**Trigger:** API (fired by Collection Routine on completion)  
**Repo:** `this-week-in-philly`  
**Connectors:** Google Drive  

### What changes from v1

- **Trigger:** API instead of schedule. No longer depends on a fixed 2-hour gap after collection — fires as soon as collection writes the manifest.
- **Input:** Reads source JSONs from Drive instead of iCloud.
- **Output:** Writes `_selections.json` to Drive.
- **No Spotify, no rendering:** Selection ends at `_selections.json`. No scope creep into presentation tasks.
- **Chaining:** On completion, fires the runner.sh trigger (API endpoint of a lightweight Presentation Routine, or a local webhook).

### Why Sonnet stays here

The selection task writes the `why` blurbs — 2–3 sentence editorial descriptions of why each event is worth attending. This is the only prose generation in the pipeline and the primary output Greg interacts with. Haiku was tested and produced noticeably weaker blurbs.

---

## Script Suite

All scripts live in `scripts/` in the repo. Each is standalone, testable, and accepts paths via CLI args or environment variables. Auth uses Google OAuth 2.0 (`credentials.json` + persisted `token.json`).

| Script | Input | Output | Notes |
|---|---|---|---|
| `attendance_check.py` | Google Calendar, `event-picks-log.csv` | Updated `event-picks-log.csv` | Must run before `csv_log.py` |
| `spotify_lookup.py` | `_selections.json` | `_spotify.json` | Concurrent lookups via ThreadPoolExecutor |
| `html_render.py` | `_selections.json`, `_spotify.json` | `report.html` | Jinja2 template (see Open Questions) |
| `calendar_create.py` | `_selections.json`, `_spotify.json` | 21 Google Calendar events | Clears prior week's picks first |
| `drive_upload.py` | `report.html` | Drive link | `disableConversionToGoogleType: true` |
| `csv_log.py` | `_selections.json`, `_spotify.json` | Appended rows in `event-picks-log.csv` | Idempotent (skips existing week+title) |

### runner.sh execution order

```bash
#!/bin/bash
WEEK_DIR=$1
HTML_PATH="$(dirname $WEEK_DIR)/report.html"

# Step 1: must complete before csv_log
python scripts/attendance_check.py &
ATTEND_PID=$!

# Step 2: runs concurrently
python scripts/spotify_lookup.py "$WEEK_DIR" &
SPOTIFY_PID=$!

wait $ATTEND_PID $SPOTIFY_PID

# Step 3: depends on spotify_lookup
python scripts/html_render.py "$WEEK_DIR" "$HTML_PATH"

# Steps 4-6: parallel, all depend on prior steps
python scripts/calendar_create.py "$WEEK_DIR" &
python scripts/drive_upload.py "$HTML_PATH" &
python scripts/csv_log.py "$WEEK_DIR" &
wait
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
├── scripts/
│   ├── attendance_check.py
│   ├── spotify_lookup.py
│   ├── html_render.py
│   ├── calendar_create.py
│   ├── drive_upload.py
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
| Google Calendar | OAuth 2.0 (`google-api-python-client`) | Enable Calendar API in Cloud Console; download `credentials.json` |
| Google Drive | OAuth 2.0 (same credentials) | Enable Drive API in same project |
| Spotify | Client credentials (`spotipy`) | Create app at developer.spotify.com; copy client ID + secret |
| GitHub | Existing `gh` auth or Claude GitHub App | Already required for Routines |

Environment variables for scripts:
```
GOOGLE_CREDENTIALS_PATH=~/.config/twip/credentials.json
GOOGLE_TOKEN_PATH=~/.config/twip/token.json
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
PICKS_LOG_PATH=~/Documents/Claude/Data/event-picks-log.csv
```

---

## Migration Path

Sequenced to keep v1 running throughout:

1. **Create GitHub repo** — `this-week-in-philly`, private
2. **Move skill files into repo** — commit all four `.claude/skills/` files; keep local copies as backup
3. **Build and test scripts** — run Agent Teams prompt against June 22 data; verify output matches v1 presentation task; complete Google OAuth and Spotify setup
4. **Migrate data writes to Drive** — update collection task to write JSONs to Drive instead of iCloud; verify selection task can read from Drive; run one manual Sunday with both v1 and v2 data writes active
5. **Create Collection Routine** — configure with Haiku, schedule trigger, Drive + Calendar connectors, Songkick page cap; run in parallel with v1 desktop task for one week
6. **Create Selection Routine** — configure with Sonnet, API trigger; wire Collection → Selection API call; verify `_selections.json` lands in Drive
7. **Wire runner.sh** — confirm scripts run cleanly end-to-end against a Drive-sourced `_selections.json`
8. **Decommission desktop tasks** — disable all three v1 scheduled tasks

Each step is independently reversible until step 8.

---

## Open Questions

**1. HTML rendering: script or Routine?**  
`html_render.py` (Jinja2 template) would eliminate the last Claude session from presentation entirely. The blocker is whether `events-report-format/SKILL.md` is stable enough to encode as a template — if the HTML structure changes often, a template requires maintenance on every change vs. Claude adapting automatically. Decision: read `events-report-format/SKILL.md` and assess stability before committing.

**2. Chrome connector in Routines**  
Tier 2–5 collection sources use `get_page_text` (Claude in Chrome). If the Chrome connector isn't available as a claude.ai connector for Routines, these sources would need playwright installed via setup script. Tier 1 sources (web_fetch, iCal, gcal) are unaffected and cover the highest-alignment picks. Decision: test Chrome connector availability in a Routine before migration; if unavailable, install playwright and update per-source extraction notes in `philadelphia-sources/SKILL.md`.

**3. runner.sh trigger mechanism**  
Selection Routine needs to trigger `runner.sh`. Options: (a) a lightweight third Routine that just clones the repo and runs `runner.sh` — clean but adds another Routine; (b) Selection Routine runs `runner.sh` directly at the end of its session — keeps scripts co-located with selection in one session but mixes concerns; (c) Selection Routine fires a local webhook that triggers `runner.sh` on the Mac — requires Mac to be on, undermining the cloud migration goal. Option (a) is cleanest.

**4. Songkick page cap impact**  
Capping at 4 pages reduces coverage for events late in the week (Thursday–Sunday) that fall on pages 5+. Actual impact unknown — the v1 session transcripts would show which Top 3 picks came from Songkick vs. other sources. If Songkick picks are rare in Top 3, the cap costs nothing meaningful.
