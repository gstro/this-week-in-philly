---
name: philly-events-presentation
description: Renders selected events into HTML report, calendar events, and additional data logging
---

---
name: philly-events-presentation
description: Renders selected events into HTML report, calendar events, and additional data logging
---

# Philadelphia Events — Report Render Task

**Schedule:** Sunday mornings, after report selection completes
**Input:** `/Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/YYYY-MM-DD/_selections.json`
**Outputs:** HTML report + Google Drive upload + Google Calendar entries + CSV log append

---

## Read first

`/Users/molo/Documents/Claude/Skills/events-report-format/SKILL.md`

Compute today's date at runtime. The report covers the full week: **the Monday immediately following today through the Sunday after that** (i.e., the upcoming 7-day window starting tomorrow). Compute the date range from today's date at runtime.

---

## Prerequisites

Verify `/Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/YYYY-MM-DD/_selections.json` exists. If missing:

```
Selections have not run for this week. Run the report selection task first.
```

---

## Step 1 — Spotify lookup

Read `_selections.json`. For every pick where `is_music: true`, search for the Spotify artist page. **Run all lookups as a batch before rendering.**

- Confident match → store URL against the pick
- No match → note as `null`
- Non-music picks → use `url` field from the selections file

```
Spotify lookup complete. [N] matched, [M] not found.
```

---

## Step 2 — Render

Follow `events-report-format` for all HTML structure, styling, and category ordering.

For each day, render the Top 3 card using `why` blurbs from `_selections.json` — do not rewrite them. Render honorable mentions below the card if present. Render full event listings by category beneath, drawn from the `events` array in `_selections.json`.

In the category blocks, events that appear in the Top 3 are included and marked with a ⭐ before the event name. Use the `note` field for the card description; for Top 3 events in the category listing, use the `note` field (not the longer `why`).

**Load once, render once.** Do not re-read source files. Do not revise picks — selections are final.

Write the report to:
```
/Users/molo/Documents/Claude/Outputs/this-week-in-philadelphia-[mon-abbr][day]-[sun-abbr][day]-[year].html
```

If `collection_failures` in `_selections.json` is non-empty, render the sources footer failure note per `events-report-format`.

```
Report complete. [N] days rendered. File written.
```

---

## Step 3 — Upload to Google Drive

Upload the HTML report to Google Drive using the Drive MCP.

1. Search for a folder named `This Week in Philadelphia` — if not found, create it:
   - `create_file` with `contentMimeType: application/vnd.google-apps.folder`, `title: This Week in Philadelphia`
   - Note the returned folder `id` as `parentId`
2. Upload the report:
   - `create_file` with `textContent: [full HTML]`, `contentMimeType: text/html`, `disableConversionToGoogleType: true`, `title: [filename]`, `parentId: [folder id]`
3. Note the returned file `id` — the shareable link is `https://drive.google.com/file/d/[id]/view`

Store the link for Step 6.

```
Drive upload complete. Link: https://drive.google.com/file/d/[id]/view
```

---

## Step 4 — Notification (stubbed)

Notification delivery is not yet implemented. Skip this step.

```
Notification: skipped (stub).
```

---

## Step 5 — Write picks to Google Calendar

1. Use `gcal_list_calendars` to find **"Curated Events"** and get its `calendarId`. If not found, stop and tell Greg to create it before continuing.
2. Use `gcal_list_events` for that calendarId over the target week, then `gcal_delete_event` for each result — clears stale picks from any prior run.
3. For each of the 21 picks from `_selections.json`, call `gcal_create_event` with:
   - **summary:** `title`
   - **start/end:** ISO 8601 datetimes in `America/New_York` from `date` + `time`; end-time estimates when not stated: literary +90 min · film +2 hrs · concert +3 hrs from door · festival +6 hrs from open
   - **location:** `address` field if present
   - **description:** `why` blurb · cost if known · `url`

Fire all `gcal_create_event` calls in a **single message**.

---

## Step 6 — Summary

Output:
- Week covered
- Total events collected and unique events after deduplication (from `_selections.json` metadata)
- Any sources that failed during collection
- Any sold-out picks (flagged in `_selections.json`)
- Suggestions for improvement: content, formatting, sourcing, efficacy, efficiency
- File path of the HTML report
- Drive link if Step 3 succeeded; otherwise note that Drive upload requires write access
- Count of calendar events written to "Curated Events"

---

## Step 7 — Data logging

Append this week's picks to `/Users/molo/Documents/Claude/Data/event-picks-log.csv`.

Source all values from `_selections.json`. Columns:

`city`, `week_of`, `day`, `title`, `venue`, `category`, `source`, `rank`, `price_tier`, `spotify_link`, `tags`, `attended`

- `city`: Philadelphia
- `week_of`: `week` field from `_selections.json`
- `rank`: 1/2/3 for Top 3 picks; `hm` for honorable mentions
- `price_tier`: free / low (under $15) / paid — infer from `cost` field
- `spotify_link`: Spotify URL if matched in Step 1, else blank
- `tags`: consistent interest labels — e.g. `punk`, `political`, `book-related`; multiple tags quoted: `"leftist, punk, film"`
- `attended`: leave blank — filled retrospectively by next week's collection task (Step 0)

Create the file with headers if it doesn't exist.
