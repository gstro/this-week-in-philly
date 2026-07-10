# Philadelphia Events Pipeline — Overview

## What it is

An automated weekly events curation pipeline for Philadelphia that runs every Sunday evening, discovers ~245 events from 28 sources, selects the best ones for Greg’s interests, and delivers a designed HTML report with calendar integration and iPhone notification.

-----

## Three Cowork Scheduled Tasks

**Task 1 — Collection** (~60–90 min, Sunday evening)
Fetches events from all sources in tier order — cheapest first, most expensive last. Writes one JSON file per source plus a `_manifest.json` to `~/philly-events/YYYY-MM-DD/`. Hard stops after writing the manifest. Recoverable: if the session dies mid-run, the next run resumes from where it left off using existing files.

**Task 2 — Report Selection** (~30 min, after collection)
Loads all source files, deduplicates (~245 → ~187 events), scores each event against personal interests, selects Top 3 per day applying selection philosophy and venue elevation rules, and writes the `why` blurb for each pick while full event context is still in memory. Writes `_selections.json` — a compact file of 21 picks plus honorable mentions — and hard stops.

**Task 3 — Report Render** (~20 min, after selection)
Reads `_selections.json` only (small context). Batches Spotify lookups for all music acts. Renders the HTML report. Uploads to Google Drive. Sends an iMessage to `gsmolodrone@gmail.com` with the Drive link and a 7-line weekly digest. Writes 21 events to the “Curated Events” Google Calendar. Appends picks to `event-picks-log.csv` for longitudinal tracking.

-----

## Four Skill Files

|Skill                       |Purpose                                                                                   |Used by task|
|----------------------------|------------------------------------------------------------------------------------------|------------|
|`philadelphia-sources`      |All source URLs, methods, tier ordering, collection discipline, resume logic              |Collection  |
|`personal-interests`        |Greg’s interest categories and preference weights                                         |Selection   |
|`event-selection-philosophy`|Ranking rules, what to prioritize/avoid, venue elevation, Philly-specific recurring events|Selection   |
|`events-report-format`      |HTML layout spec, Top 3 card, category emoji headers, Spotify linking, sources footer     |Render      |

Tasks are thin — they handle environment-specific concerns (local file paths, calendar names, osascript syntax) and delegate all domain logic to skills.

-----

## File Handoffs

```
Sources (28)
    ↓ web_fetch / get_page_text / gcal_list_events
~/philly-events/YYYY-MM-DD/
    [source-name].json × 28
    _manifest.json
    ↓
_selections.json
    (21 Top 3 picks + honorable mentions, why blurbs, Spotify URLs)
    ↓
HTML report → Google Drive → iMessage
                           → Google Calendar (21 events)
                           → event-picks-log.csv
```

-----

## Source Architecture

28 sources organized into 5 tiers by session cost:

- **Tier 1** — `web_fetch` / MCP: Philly Ask A Punk (JSON API), Luma (iCal), The Rotunda (web_fetch), Iffy Books + Wooden Shoe Books + Trakt.tv (Google Calendar MCP)
- **Tier 2** — Simple `get_page_text`: R5 Productions, Hive76, Philadelphia Film Society, Harriet’s Bookshop, Free Library
- **Tier 3** — Moderate verbosity: PhilaMOCA + Phillygoth, cinéSPEAK, Lightbox, Philadelphia Citizen, WXPN
- **Tier 4** — Meetup iCal feeds: 8 groups via `web_fetch` (confirmed working Jun 2026)
- **Tier 5** — High cost, run last: Philly-Shows, Do215 (7 day URLs), Billy Penn, Songkick

Tier ordering ensures that if a session runs short, the broad aggregators (Do215, Songkick) are cut rather than the high-alignment specialist sources.

-----

## Session Economics

The three-task split was designed around context accumulation costs:

|Task      |Peak context                          |Est. total token-reads|
|----------|--------------------------------------|----------------------|
|Collection|~500 tokens (write-and-forget)        |~65K                  |
|Selection |~43,000 tokens (full event set)       |~1.8M                 |
|Render    |~13,000 tokens (_selections.json only)|~850K                 |
|**Total** |                                      |**~2.7M**             |

vs. ~5.8M for the original unsplit single task. The key insight: render is cheap because it reads `_selections.json` (~21 picks) rather than all 245 events.

-----

## Feedback Loop

Step 0 of every collection run checks last week’s “Curated Events” calendar. Greg’s convention: delete events he didn’t attend. Events still on the calendar get `attended = true` written back to `event-picks-log.csv`; absent events get `attended = false`. Over time this builds a longitudinal record of what got picked, what got attended, and what got skipped — usable for tuning the selection philosophy.

-----

## Deliverables Inventory

|File                                     |Location                     |
|-----------------------------------------|-----------------------------|
|`task-collection-slim.md`                |Cowork scheduled task        |
|`task-report-selection.md`               |Cowork scheduled task        |
|`task-report-render.md`                  |Cowork scheduled task        |
|`philadelphia-sources/SKILL.md`          |Replace existing             |
|`event-selection-philosophy/SKILL.md`    |Replace existing             |
|`events-report-format/SKILL.md`          |Replace existing             |
|`personal-interests/SKILL.md`            |Keep existing (correct as-is)|
|`philadelphia-report-generation/SKILL.md`|**Delete** — deprecated      |

One outstanding item: add Philly coffee venue examples (ReAnimator, Elixr, La Colombe) to `personal-interests` before the first run.

-----

## Next Steps

1. **Test the osascript iMessage command** in Cowork before the first live run — it’s the only unvalidated step in the render task
1. **Run the three tasks sequentially** for the first time — collection alone first, then selection, then render; validate each handoff file before proceeding
1. **After the first run, review the Step 8 summary output** — that’s where source yield, selection quality, and formatting gaps will surface most clearly, and it’s the foundation for tuning the skill files going forward