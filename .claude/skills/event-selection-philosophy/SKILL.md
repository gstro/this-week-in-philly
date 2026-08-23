---
name: event-selection-philosophy
description: Selection logic and ranking rules for the weekly This Week in Philadelphia events report. Use this skill when choosing which events to include and how to rank them. Apply after gathering candidates using the philadelphia-sources skill and weighting them against personal-interests. Governs what to prioritize, what to avoid, and how to break ties.
---

# Event Selection Philosophy

Apply these rules when evaluating and ranking event candidates for the weekly report.

## Tie-Break Precedence

When candidates are genuinely close on merit, resolve in this order — highest first:

1. Interest-tier alignment (Core > Strong > Flavor; see `personal-interests`)
2. Uniqueness / easy-to-miss
3. Community or political stakes
4. Multi-interest overlap
5. Venue Elevation (see below)

This exists because, left unstated, the model has been resolving ties venue-first: across two
observed weeks, four venues (three of them Venue-Elevation-listed) took 9 of 21 Top 3 slots,
including one venue at a 75–100% hit rate against its candidate count. **Venue Elevation is the
last item in this list, not a substitute for it** — it may only decide between candidates already
essentially tied after 1–4 above; it must never lift a weaker candidate over a stronger one.

## Prioritize

1. Unique or lesser-known events that are easy to miss — a free library screening, a bookstore reading, a local DIY show
2. Events with community or political dimensions
3. Events where multiple interests overlap (e.g., a reading at an independent bookstore by a politically engaged author; a free film screening with a leftist theme)

## Also Include (don't exclude just because they're well-known)

- Genuinely must-see popular acts or events that are rare visits to Philadelphia
- Events that would be talked about afterward

## Recurring Events to Deprioritize (Philly-Specific)

Note these in listings but do not pick as Top 3 unless something special is occurring:
- **The Rotunda** — weekly improvised music jam (Wednesdays), Vogue Practice Session (Tuesdays)
- **Hive76** — Open House every Sunday 2:30–5pm *(source not currently producing candidates in
  Collection — this entry governs the rare case one appears via another source)*

## Avoid

- Recurring weekly events as a Top 3 pick unless there's a special guest or specific reason to highlight this instance
- Events at large corporate venues unless the act is truly unmissable
- Events with no verifiable source or unconfirmed details — add *(confirm details)* rather than omitting

## Weekly Caps

Enforced across the **whole week**, not per day — track running totals as you process each day's
candidates in sequence, since a violation is only visible once more than one day has been picked.

- **Venue cap:** at most 2 Top 3 slots per week at the same venue. Key on the venue's street
  address (write it to `address`, same as you already do for calendar creation) — venue name
  strings are not consistent enough to key on directly (e.g. "Iffy Books" vs. "Iffy Books, 404 S.
  20th St., Philadelphia, 19146, United States"; "Ortlieb's" vs. "Ortlieb's, Philadelphia, PA"). If
  a candidate has no discoverable address, fall back to a normalized venue name (lowercase, text
  before the first comma). The mechanical check (`scripts/check_selection.py`) normalizes the
  address key by stripping punctuation/whitespace, so "404 S. 20th St.," and "404 S 20th St," are
  already treated as one venue there — but don't rely on that as a reason to be loose with spelling
  here: this cap is tracked live, as you go, well before the check ever runs, and a real 2026-08-03
  week split 5 Iffy Books slots into 4+1 by spelling the same address two different ways, letting
  the cap pass unenforced at authoring time.
- **Same-series cap:** no two Top 3 picks in one week from the same series, class, or
  organizer-run program, regardless of exact title. Two different weekly workshop topics at the
  same venue under the same program name (e.g. "Beginner Soldering: Li-Ion Battery Pack" and
  "Beginner Soldering: LED Spinning Top") still count as the same series — judge by the shared
  program, not by whether the titles are byte-identical.

## Data Plausibility Checklist

Aggregator data is frequently wrong in specific, recognizable ways. Before finalizing a Top 3 pick
or writing its `why`, check for and re-derive rather than pass through as-is:
- A start time of 7:00 AM or 12:00 AM/1:00 AM — usually a scrape artifact (a listing's creation
  timestamp, a "doors at midnight" misparse), not the real start time
- A date that doesn't match the event's own name (a "Cinco de Mayo" listing dated in August)
- A cost that reads like a budget or renovation figure rather than a ticket price (e.g. "$15"
  scraped from a "$15M renovation" description)
- A venue address outside Philadelphia — allowed only at a high bar (something genuinely
  exceptional), and the `why` must name the travel involved; see `personal-interests`'s Geography
  section for the home-base anchor this is judged against. A real 2026-08-10 week shipped two Top 3
  picks in Glenside and Oaks, PA (~25 mi out) with no such note.
- Near-identical titles that are the same event listed twice (e.g. "Babalouie BBQ" and "EF:
  Babalouie BBQ") — treat as one candidate, not two

## Aggregator Provenance

Do215 supplies the large majority of candidates most weeks (76–78% across two observed weeks) and
is the source of nearly every plausibility defect above. Treat a **Do215-only listing for a
commercial venue promotion** (a bar special, a brand tasting, a brewery food truck night) as
low-signal by default, absent corroboration from another source or the venue's own listing —
that default is what should be doing most of the filtering, not catching each bad listing by luck.

## Blurb Integrity

Every claim in a `why` (or `note`) must be traceable to the source data or stated as your own
general knowledge, explicitly flagged as such — never present an inferred price, a guessed
"typical for this venue" pattern, or an assumed detail as fact. If you're inferring, say so in the
text (e.g. "likely pay-what-you-can, matching this venue's usual policy") rather than asserting it
as a known fact.

## Venue Elevation

Elevate events at these venues **only as the last step in Tie-Break Precedence above** — they
consistently produce high-alignment picks, but elevation must never override 1–4 of that ordering:
- **PhilaMOCA** — horror, underground art, weird culture
- **Iffy Books** — DIY electronics + speculative fiction + leftist politics
- **Harriet's Bookshop** — politically engaged literary events *(elevate if present — this source
  is not currently producing candidates in Collection; do not expect to see it)*
- **The Rotunda** — free/PWYW community arts, film, experimental music
- **Wooden Shoe Books** — anarchist radical bookstore, readings and community events
- **First Unitarian Church** — Philly's most storied punk/hardcore venue; all R5 all-ages shows
  *(elevate if present — not currently producing candidates in Collection)*
- **Lightbox Film Center** — premier repertory/arthouse cinema *(elevate if present — not
  currently producing candidates in Collection)*
