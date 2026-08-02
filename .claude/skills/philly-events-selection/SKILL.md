---
name: philly-events-selection
description: Selects Philadelphia's Top 3 events per day from Collection's output and writes the why blurbs. Use this skill when running the weekly Selection stage of the This Week in Philly pipeline, after Collection has produced a week's _candidates.json. Reads personal-interests and event-selection-philosophy for judgment; writes _selections.json for Presentation to consume.
output_directory: data
---

# Philadelphia Events — Selection Task

**Schedule:** Sunday mornings, ~30 minutes after Collection's own cron (v1's original cadence — this
task's Routine runs on its own schedule, not an event pushed from Collection; see the guard below).
**Input:** `data/YYYY-MM-DD/_candidates.json` — written by `scripts/prepare_selection_input.py` as a
`collection.yml` step, alongside the rest of Collection's output.
**Output:** `data/YYYY-MM-DD/_selections.json`

Adapted from `docs/v1/Scheduled/philly-events-selection/SKILL.md` (kept as historical reference, not
updated) for v2: repo-relative paths instead of the v1 iCloud path, and Phase 2 (Deduplicate) removed
entirely — it's now fully owned by `prepare_selection_input.py`, since v1's own dedup rule was already
mechanical. This task starts at scoring.

---

## Read first

1. `.claude/skills/personal-interests/SKILL.md`
2. `.claude/skills/event-selection-philosophy/SKILL.md`

Always select for the full week: **the Monday immediately following today through the Sunday after
that** (i.e., the upcoming 7-day window starting tomorrow). Compute the date range from today's date
at runtime.

---

## Prerequisites

Verify `data/YYYY-MM-DD/_candidates.json` exists for the target week. If missing:

```
Collection has not produced usable candidates for this week. Check collection.yml's most recent run
before re-triggering Selection.
```

This is the safety net for a silent Sunday: this task's own Routine runs on a fixed schedule rather
than being triggered by Collection's completion, so it must be able to tell "Collection hasn't run
yet or failed" from "Collection ran and there's real data" on its own.

If `_selections.json` already exists for this week, **stop and notify — do not overwrite without
confirmation.** Re-running Selection against an already-selected week is very likely a mistake, not a
retry.

---

## Phase 1 — Load

Read `_candidates.json`. Its `candidates` array is already flattened (every event tagged with
`source`), exact-duplicate-collapsed, and has same-title/venue recurring listings (3+ distinct dates
this week) collapsed into one representative entry carrying `occurrences` and `recurrence_count`. Its
`collection_failures` array is already built in the shape `_selections.json` needs — copy it through
directly, no need to recompute.

```
Loaded [N] candidates ([R] recurring group(s), [F] sources failed during collection).
```

---

## Phase 2 — Score and group

Apply `personal-interests` weighting to each candidate. Group by date (Monday–Sunday). Identify
high-alignment and low-alignment candidates qualitatively — **no numeric scores**.

**Trakt.tv releases:** Set venue to `Theatrical release` if none present. Eligible for Top 3 if they
match horror/occult interests.

**Recurring-group candidates** (`recurrence_count` present): this is exactly the case
`event-selection-philosophy`'s "Avoid: recurring weekly events... unless something special is
occurring" rule exists for. `recurrence_count`/`occurrences` tells you the series repeats this many
times this week — apply the judgment yourself; the annotation is a signal, not a verdict. A recurring
series that's still worth a Top 3 slot (a genuinely special single occurrence) should say so in its
`why` blurb.

```
Scoring complete. [N] days, [E] candidates total.
```

---

## Phase 3 — Select Top 3 per day and write

Apply `event-selection-philosophy` rules for each day. **Complete all 7 days before writing the
selections file.**

Per day:
1. Flag candidates with no verifiable URL as *(confirm details)* — do not exclude
2. Apply Prioritize rules: free/PWYW, unique/easy-to-miss, community/political, multi-interest overlap
3. Apply Avoid rules: recurring weekly events (including candidates with `recurrence_count`), large
   corporate venues
4. Apply Venue Elevation for tie-breaking
5. Note known Philly-specific recurring events (per `event-selection-philosophy`'s "Recurring Events to
   Deprioritize" list) in listings but not Top 3

For each Top 3 pick, write a `why` blurb: 2–3 sentences explaining what makes this worth attending over
everything else that day. First sentence: what it is and why it's notable. Second: what makes it
specific to this moment or place. Third (optional): the practical case — cost, access, context. Write
with personality and specificity — this text goes directly into the rendered report.

Fewer than 3 qualifying events on a given day is acceptable.

**Write `_selections.json`** using this schema:

```json
{
  "week": "2026-06-08",
  "generated_at": "2026-06-08T20:45:00",
  "total_events_after_dedup": 187,
  "collection_failures": ["free-library (Cloudflare bot-check)"],
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
- `time`: **always a single, cleanly parseable start time** (`H:MM AM/PM`, e.g. `"7:00 PM"`) — never a
  list, a doors/show pair, or a range, even when the candidate's own `time` or `description` has one.
  If a candidate genuinely has multiple showtimes, a doors/show split, or a time range, put ONE clean
  representative start time in `time` and describe the rest as prose in `why`/`note` instead (e.g.
  `note: "Multiple showtimes: 1pm, 3:50pm, 6:30pm, 9pm."` or `note: "Doors 6:00 PM, show at 7:00 PM."`)
  — this is the real, established pattern already used throughout the golden 2026-06-22 report (e.g.
  `BACKROOMS (2026)`: `time: "1:00 PM"`, `note: "...Multiple showtimes: 1pm, 3:50pm, 6:30pm, 9pm."`).
  `html_render.py`'s `display_time()` already appends a "+" suffix to `time` whenever `note` mentions
  "multiple showtimes" — that's this field's actual contract, not an incidental convenience.
  `calendar_create.py`'s `parse_start()` only matches a single `%I:%M %p` string; anything else means
  that pick's calendar event silently never gets created (confirmed on the real 2026-08-03 week: 5 of
  21 Top 3 picks lost their calendar entry this way, all from writing multiple times or a doors/show
  pair straight into `time` instead of following this pattern).
- `is_music`: true for any act where a Spotify artist page lookup makes sense
- `sold_out`: true if any source flagged the event as sold out (check the candidate's `description` —
  `prepare_selection_input.py` preserves a sold-out mention found on a discarded duplicate as a
  `[Note: ...]` prefix, since there's no structured sold-out field at Collection's stage) — still
  include in Top 3 if worth attending, note in report
- `address`: full street address for Google Calendar; omit field if unknown (top3 only — not needed in
  `events`)
- `honorable_mentions`: title and venue only — 2–3 max per day, omit array if none
- `why`: 2–3 sentences for Top 3 picks only — more substantial than `note`
- `note`: 1–2 sentences for events in the `events` array — carry from the candidate's `description` if
  useful, otherwise write fresh. Omit if there is genuinely nothing useful to say beyond title/venue/time.
- `events`: all candidates for the day, sorted by category order (per `events-report-format`), then
  chronologically by start time within each category. Top 3 picks **must** be included in `events` — the
  render task uses this array for the full category listing and marks them with ⭐.
- `collection_failures`: copy `_candidates.json`'s `collection_failures` array through unchanged.

```
Selection complete. Top 3 written for [N]/7 days. _selections.json saved.
```

---

## Commit and push

```
git add data/YYYY-MM-DD/_selections.json
git commit -m "Selection: week of YYYY-MM-DD"
git push
```

This push is what fires `presentation.yml` (`on: push`, `paths: ['data/**/_selections.json']`) — no
API call, no webhook, no separate trigger.

---

## Stop

Do not proceed to Spotify lookup or rendering. Those run in `scripts/runner.sh`, invoked by
`presentation.yml` from this push.
