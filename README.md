# This Week in Philly

An automated weekly events curation pipeline for Philadelphia. Every Sunday evening it gathers upcoming events from roughly 30 local sources — venue calendars, community spaces, film societies, Meetup groups, and city-wide aggregators — scores them against personal interests, and delivers a designed HTML report with the week's Top 3 picks per day, complete with calendar integration and a phone notification.

## How it works

The pipeline runs as three scheduled tasks, each handing its output to the next through files on disk:

```
Sources (~30, in tiers)
    ↓  Collection
~/philly-events/YYYY-MM-DD/
    [source-name].json (one per source)
    _manifest.json
    ↓  Selection
_selections.json
    (Top 3 picks per day + honorable mentions, "why" blurbs, Spotify URLs)
    ↓  Render
HTML report → Google Drive → phone notification
                           → Google Calendar ("Curated Events")
                           → event-picks-log.csv
```

**1. Collection** fetches events from every source, working tier by tier from cheapest to most expensive. It writes one JSON file per source plus a `_manifest.json`, then stops. The run is resumable: if a session dies partway through, the next run picks up from the files already written.

**2. Selection** loads all collected events, deduplicates them, scores each against personal interest categories, and applies the selection philosophy and venue elevation rules to pick the Top 3 events per day plus honorable mentions. It writes the "why" blurb for each pick while full event context is still in memory, saves everything to a compact `_selections.json`, and stops.

**3. Render** reads only `_selections.json`. It batches Spotify lookups for music acts, renders the HTML report, uploads it to Google Drive, sends a notification with the link and a short weekly digest, writes the picks to the "Curated Events" Google Calendar, and appends them to `event-picks-log.csv` for longitudinal tracking.

## Design principles

**Tasks are thin; skills hold the domain logic.** The scheduled tasks handle environment-specific concerns (file paths, calendar names, notification syntax) and delegate everything else to four skill files:

| Skill                          | Purpose                                                                    | Used by    |
| ------------------------------ | -------------------------------------------------------------------------- | ---------- |
| `philadelphia-sources`         | Source URLs, fetch methods, tier ordering, collection discipline, resume logic | Collection |
| `personal-interests`           | Interest categories and preference weights                                 | Selection  |
| `event-selection-philosophy`   | Ranking rules, what to prioritize and avoid, venue elevation, recurring Philly events | Selection  |
| `events-report-format`         | HTML layout spec, Top 3 cards, category emoji headers, Spotify linking, sources footer | Render     |

**Sources are tiered by cost, cheapest first.** Lightweight JSON APIs and iCal feeds run before verbose page scrapes and broad aggregators. If a session runs short, it's the city-wide aggregators that get cut — not the high-alignment specialist sources.

**The three-task split bounds context.** Each stage hard-stops after writing its handoff file, so no single session accumulates the full pipeline's context. Rendering is cheap because it reads the compact selections file rather than the entire collected event set.

## Feedback loop

Each collection run starts by checking last week's "Curated Events" calendar. The convention: delete events you didn't attend. Events still on the calendar are marked `attended = true` in `event-picks-log.csv`; deleted ones are marked `attended = false`. Over time this builds a record of what got picked, attended, and skipped — raw material for tuning the selection philosophy.

## Repository contents

- [`docs/v1/philly-events-pipeline-overview.md`](docs/v1/philly-events-pipeline-overview.md) — the detailed design document, including source tiers, session economics, and file handoff specifics.
- [`docs/V2_DESIGN.md`](docs/V2_DESIGN.md) and [`docs/V2_IMPLEMENTATION_PLAN.md`](docs/V2_IMPLEMENTATION_PLAN.md) — the cloud rewrite (v2) this repo is migrating to; v1 above remains the currently-running system until cutover.
