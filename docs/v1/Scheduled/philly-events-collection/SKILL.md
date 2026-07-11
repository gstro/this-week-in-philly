---
name: philly-events-collection
description: Collection events from various Philly sources for the upcoming week
---

# Philadelphia Events — Collection Task

**Schedule:** Sunday mornings
**Output:** `/Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/YYYY-MM-DD/` — per-source JSON files + manifest

---

## Read first

Read and follow `/Users/molo/Documents/Claude/Skills/philadelphia-sources/SKILL.md` before doing anything else. It contains all source URLs, extraction methods, tier ordering, collection discipline, and resume logic.

---

## Step 0 — Attendance check (last week)

Compute last week's date range (the Monday–Sunday that just ended).

1. Use `gcal_list_calendars` to find **"Curated Events"** and get its `calendarId`.
2. Use `gcal_list_events` with that calendarId for last week's Monday–Sunday range.
3. Open `/Users/molo/Documents/Claude/Data/event-picks-log.csv`. Find all rows where `week_of` matches last Monday's date and `city` is `Philadelphia`.
4. For each row: if a matching title still appears in the calendar → `attended = true`; if absent → `attended = false`. Write the updated CSV back.

**Convention:** Greg deletes calendar events he did not attend; presence means he went.

If the calendar has no Philadelphia events for last week, skip silently and continue.

---

## Step 1 — Collect events

Always collect for the full week: **the Monday immediately following today through the Sunday after that** (i.e., the upcoming 7-day window starting tomorrow). Compute the date range from today's date at runtime.

Follow the philadelphia-sources skill exactly — sources, tier order, collection discipline, per-source file naming, and resume behavior are all specified there.

---

## Step 2 — Stop

After writing `_manifest.json`, emit the end-of-collection summary and stop.
Report generation runs as a separate task.
