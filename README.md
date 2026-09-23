# This Week in Philly

An automated weekly events-curation pipeline for Philadelphia. Every Sunday it collects
roughly 500–1000 raw events from ~22 local sources — venue calendars, community spaces,
film societies, Meetup groups, and city-wide aggregators — narrows them against personal
interests, and publishes an HTML report with the week's Top 3 picks per day, plus a
Google Calendar of the picks and (when Spotify auth is configured) a weekly playlist.

The report publishes to **[gstro.github.io/this-week-in-philly](https://gstro.github.io/this-week-in-philly/)**.

## How it works

Three stages, chained by committed file handoffs in `data/<week>/` (`git push`, not a
local filesystem or iCloud). Two of the three run as plain GitHub Actions scripts with
no model involved; only Selection is a Claude Code Routine.

```
Collection    → per-source JSONs, _manifest.json, _candidates/       (scripted, no model)
   ↓ collection.yml fires Selection's Routine via API trigger on push
Selection     → _selection_annotations.json                          (the one Routine, Sonnet)
   ↓ push triggers presentation.yml
Presentation  → _selections.json, HTML report, Calendar, playlist     (scripted, no model)
```

**1. Collection** (`scripts/collect_week.py`, run by `.github/workflows/collection.yml` on a
Sunday cron or manual dispatch) fetches every source deterministically — JSON APIs, iCal
feeds, and per-source parsers in `scripts/event_parsers/` — and writes one JSON file per
source plus `_manifest.json`. `check_yield.py` gates the run against per-source floors in
`data/expected_yield.json`; `prepare_selection_input.py` dedupes and splits the week into
per-day candidate files. The workflow commits and pushes `data/<week>/`, then fires
Selection's Routine via its API trigger (with Selection's own cron as a fallback in case
that fires before Collection's data has landed).

**2. Selection** is the only LLM stage — a Claude Code Routine reading
`.claude/skills/philly-events-selection/SKILL.md` (plus `personal-interests` and
`event-selection-philosophy` for judgment). It scores each day's candidates, picks Top 3
plus honorable mentions, writes a "why" blurb per pick, and pushes
`_selection_annotations.json` — judgment calls only, keyed by candidate id; it does not
re-transcribe event data it was already handed.

**3. Presentation** (`.github/workflows/presentation.yml`, triggered by that push) is
fully scripted: `merge_selections.py` reconstructs the full `_selections.json` from the
annotations, `check_selection.py` validates it, then `scripts/runner.sh` runs
`spotify_lookup.py` → `spotify_playlist.py` → `html_render.py` → `calendar_create.py` in
that order (the playlist needs the lookup's matches; the report header needs the
playlist's URL). `html_render.py` renders `templates/report.html.j2` to
`docs/weeks/<week>.html` and regenerates `docs/index.html`; GitHub Pages serves `docs/`.

## Design principles

**Tasks are thin; skills hold the domain logic — for the one stage that's still a
Routine.** Now that Collection and Presentation are scripted, only Selection actually
loads skills at runtime:

| Skill                          | Purpose                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| `philly-events-selection`      | The Selection task itself — schema, caps, the nine canonical categories     |
| `personal-interests`           | Interest categories and preference weights                                 |
| `event-selection-philosophy`   | Ranking rules, what to prioritize and avoid, venue elevation, recurring Philly events |

`philadelphia-sources` and `events-report-format` used to live in `.claude/skills/` too,
documenting Collection's and Presentation's old Routine-driven behavior. Both were
**deleted** once nothing loaded them at runtime any more — Collection's per-source logic
now lives in each `scripts/event_parsers/*.py` module's own docstring — depth varies,
see `collect_week.py`'s comment for which ones inherited real quirks/rationale versus a
one-line tech-shape description — and the report's actual spec is
`templates/report.html.j2`'s own comments.

**Sources are tiered by cost, cheapest first** in Collection's fetch order — lightweight
JSON APIs and iCal feeds before anything needing a rendered browser page
(`fetch_page_text.py`, Playwright).

**No silent caps or invented data.** A category's rendered card count is capped for
readability, but the true pre-cap count always renders too (`+N more not shown`, and the
report's "Week in Numbers" section); nothing renders a guessed price, address, or
category the source didn't actually provide.

## Feedback loop

Designed, not yet live: Greg deleting a Curated Events calendar entry he didn't attend is
meant to mark it `attended = false` in a picks-log CSV, with survivors marked
`attended = true` — raw material for tuning selection over time. `attendance_check.py` and
`csv_log.py` implement this and carry their own tests, but are currently **shelved out of
`runner.sh`** pending a decision on how to seed/init the picks log. See CLAUDE.md's
"Attendance feedback loop" entry for the incident that's kept this deliberately paused.

## Repository layout

- `scripts/` — the production Python pipeline; every script is a standalone CLI.
- `templates/` — the Jinja2 templates `html_render.py` renders.
- `tests/` — pytest suite, plus a byte-pinned golden-output fixture (`tests/golden/`).
- `src/` — an in-progress TypeScript port of select `scripts/*.py` modules. Not yet wired
  into any workflow; the `.py` originals are what actually runs.
- `.claude/skills/` — domain knowledge; see Design principles above for what's still live.
- `.github/workflows/` — `collection.yml`, `presentation.yml` (production), plus CI guards
  (`collection-check.yml`, `lint.yml`).
- `data/<week>/` — each week's committed pipeline artifacts.
- `docs/weeks/<week>.html` — published reports; `docs/index.html` is regenerated from
  these on every render.
- `docs/*.md` — design docs and investigation write-ups (several still cited as live
  rationale for code, others carry status banners noting what's since shipped).
- `docs/v1/` — a frozen snapshot of the desktop system v2 replaced. Reference only.

## Development

Python (CI-enforced via `.github/workflows/lint.yml`):

```
pytest                     # offline suite; pytest -m network for live-source tests, manual only
ruff check scripts/
mypy
```

Set up a venv with `scripts/requirements.txt` (add `-collection.txt` for anything
touching the Playwright/browser-fetch path, `-dev.txt` for the tools above).

TypeScript (not yet CI-enforced — run manually against `src/`):

```
npm test          # vitest
npm run lint       # eslint
npm run typecheck  # tsc
npm run build      # tsc
```

## Further reading

- [`docs/SETUP.md`](docs/SETUP.md) — manual setup: vendor accounts (Google, Spotify),
  where each secret/env var goes, and the Selection Routine's own configuration.
- [`docs/v1/philly-events-pipeline-overview.md`](docs/v1/philly-events-pipeline-overview.md) — the original v1 desktop design: source tiers, session economics, file handoffs.
- [`docs/V2_DESIGN.md`](docs/V2_DESIGN.md) and [`docs/V2_IMPLEMENTATION_PLAN.md`](docs/V2_IMPLEMENTATION_PLAN.md) — the cloud rewrite this repo now runs, and the phased plan it was built to. Both are historical design records at this point (see their status banners) — for the current architecture, see CLAUDE.md.
- [`docs/REPORT_IMPROVEMENTS_BRAINSTORM.md`](docs/REPORT_IMPROVEMENTS_BRAINSTORM.md) and [`docs/SELECTION_IMPROVEMENTS_BRAINSTORM.md`](docs/SELECTION_IMPROVEMENTS_BRAINSTORM.md) — the live design-iteration record for the report and for Selection's judgment quality.
