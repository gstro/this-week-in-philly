---
name: philly-events-selection
description: Selects preferred events based on personal interests
---

# Philadelphia Events — Report Selection Task

**Schedule:** Sunday mornings, ~30 minutes after collection completes
**Input:** `/Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/YYYY-MM-DD/` — written by the collection task
**Output:** `/Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/YYYY-MM-DD/_selections.json`

---

## Read first

1. `/Users/molo/Documents/Claude/Skills/personal-interests/SKILL.md`
2. `/Users/molo/Documents/Claude/Skills/event-selection-philosophy/SKILL.md`

Always select for the full week: **the Monday immediately following today through the Sunday after that** (i.e., the upcoming 7-day window starting tomorrow). Compute the date range from today's date at runtime.

---

## Prerequisites

Verify `/Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/YYYY-MM-DD/_manifest.json` exists and at least one source has `status: ok` with events. If missing:

```
Collection has not run for this week. Run the collection task first.
```

If `_selections.json` already exists for this week, stop and notify — do not overwrite without confirmation.

---

## Phase 1 — Load

Read `_manifest.json`. Load all source files with `status: ok` into a flat event list. Note sources with `status: failed` — these carry into the selections file.

```
Loaded [N] source files, [E] total events. [F] sources failed during collection.
```

---

## Phase 2 — Deduplicate

Same title + same venue + same date = duplicate. Source priority when merging:

1. **R5 Productions** — authoritative on price, sold-out status, support acts, fundraiser beneficiaries
2. **PhilaMOCA** — authoritative for its own venue events
3. **Philly Ask A Punk** — authoritative for DIY/punk shows not on R5
4. **Do215** — prefer over Songkick when both present
5. All other sources

When no clear priority applies, keep the entry with the most complete fields. If any source marks an event sold out, carry that status regardless of which source is kept. For support act conflicts, keep R5's listing.

**Multi-day events:** Philly Ask A Punk `multidate` events — list under the first day in the target week only.

```
Deduplication complete. [N] duplicates removed. [E] unique events remaining.
```

---

## Phase 3 — Score and group

Apply `personal-interests` weighting to each event. Group by date (Monday–Sunday). Identify high-alignment and low-alignment candidates qualitatively — no numeric scores.

**Trakt.tv releases:** Set venue to `Theatrical release` if none present. Eligible for Top 3 if they match horror/occult interests.

```
Scoring complete. [N] days, [E] events total.
```

---

## Phase 4 — Select Top 3 per day and write

Apply `event-selection-philosophy` rules for each day. **Complete all 7 days before writing the selections file.**

Per day:
1. Flag events with no verifiable URL as *(confirm details)* — do not exclude
2. Apply Prioritize rules: free/PWYW, unique/easy-to-miss, community/political, multi-interest overlap
3. Apply Avoid rules: recurring weekly events, large corporate venues
4. Apply Venue Elevation for tie-breaking
5. Note Philly-specific recurring events (Rotunda jams, Hive76 Open House) in listings but not Top 3

For each Top 3 pick, write a `why` blurb: 2–3 sentences explaining what makes this worth attending over everything else that day. First sentence: what it is and why it's notable. Second: what makes it specific to this moment or place. Third (optional): the practical case — cost, access, context. Write with personality and specificity — this text goes directly into the rendered report.

Fewer than 3 qualifying events on a given day is acceptable.

**Write `_selections.json`** using this schema:

```json
{
  "week": "2026-06-08",
  "generated_at": "2026-06-08T20:45:00",
  "total_events_after_dedup": 187,
  "collection_failures": ["songkick"],
  "days": [
    {
      "date": "2026-06-08",
      "day_name": "Monday",
      "top3": [
        {
          "rank": 1,
          "title": "Saetia",
          "venue": "First Unitarian Church",
          "address": "2125 Chestnut St, Philadelphia, PA 19103",
          "time": "7:00 PM",
          "cost": "$15",
          "url": "https://r5productions.com/events/...",
          "category": "🎵 Music & Concerts",
          "source": "R5 Productions",
          "is_music": true,
          "sold_out": false,
          "why": "Saetia reunite for a rare one-night benefit show for Juntos Philadelphia — hardcore royalty with a reason beyond the music. They haven't played Philadelphia since 2019 and this is the only East Coast date. $15, all ages, First Unitarian."
        }
      ],
      "honorable_mentions": [
        {
          "title": "Bright Bulb Screenings: Iranian Cinema Double Feature",
          "venue": "The Rotunda"
        }
      ],
      "events": [
        {
          "title": "Saetia",
          "venue": "First Unitarian Church",
          "time": "7:00 PM",
          "cost": "$15",
          "url": "https://r5productions.com/events/...",
          "category": "🎵 Music & Concerts",
          "source": "R5 Productions",
          "is_music": true,
          "sold_out": false,
          "note": "Rare reunion show, only East Coast date. Benefit for Juntos Philadelphia."
        },
        {
          "title": "Bright Bulb Screenings: Iranian Cinema Double Feature",
          "venue": "The Rotunda",
          "time": "7:00 PM",
          "cost": "Free",
          "url": "https://www.therotunda.org/...",
          "category": "🎬 Film & Cinema",
          "source": "The Rotunda",
          "is_music": false,
          "sold_out": false,
          "note": "Monthly repertory film night at the Rotunda — free, no RSVP required."
        }
      ]
    }
  ]
}
```

**Field notes:**
- `category`: assign one of the following canonical strings exactly — do not invent variants:
  - `🎵 Music & Concerts`
  - `🎬 Film & Cinema`
  - `📚 Literary`
  - `🤝 Community & Politics`
  - `🎨 Arts & Workshops`
  - `💻 Tech & Maker`
  - `🌿 Markets & Outdoors`
  - `👻 Horror & Occult`
  - `🎪 Festivals & Major Events`
- `is_music`: true for any act where a Spotify artist page lookup makes sense
- `sold_out`: true if any source flagged the event as sold out — still include in Top 3 if worth attending, note in report
- `address`: full street address for Google Calendar; omit field if unknown (top3 only — not needed in `events`)
- `honorable_mentions`: title and venue only — 2–3 max per day, omit array if none
- `why`: 2–3 sentences for Top 3 picks only — more substantial than `note`
- `note`: 1–2 sentences for events in the `events` array — carry from source description if useful, otherwise write fresh. Omit if there is genuinely nothing useful to say beyond title/venue/time.
- `events`: all deduplicated events for the day, sorted by category order (per `events-report-format`), then chronologically by start time within each category. Top 3 picks **must** be included in `events` — the render task uses this array for the full category listing and marks them with ⭐.

```
Selection complete. Top 3 written for [N]/7 days. _selections.json saved.
```

---

## Stop

Do not proceed to Spotify lookup or rendering. Those run in the report render task.
