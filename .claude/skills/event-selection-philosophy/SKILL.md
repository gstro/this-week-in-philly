---
name: event-selection-philosophy
description: Selection logic and ranking rules for the weekly This Week in Philadelphia events report. Use this skill when choosing which events to include and how to rank them. Apply after gathering candidates using the philly-sources skill and weighting them against personal-interests. Governs what to prioritize, what to avoid, and how to break ties.
---

# Event Selection Philosophy

Apply these rules when evaluating and ranking event candidates for the weekly report.

## Tie-Break Precedence

When candidates are genuinely close on merit, resolve in this order — highest first:

1. Interest-tier alignment (Core > Strong > Flavor; see `personal-interests`)
2. Uniqueness / easy-to-miss
3. Community or political stakes
4. Multi-interest overlap
5. Free or pay-what-you-wish
6. Venue Elevation (see below)

This exists because, left unstated, the model has been resolving ties venue-first: across two
observed weeks, four venues (three of them Venue-Elevation-listed) took 9 of 21 Top 3 slots,
including one venue at a 75–100% hit rate against its candidate count. **Venue Elevation is the
last item in this list, not a substitute for it** — it may only decide between candidates already
essentially tied after 1–5 above; it must never lift a weaker candidate over a stronger one.

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
  before the first comma).
- **Same-series cap:** no two Top 3 picks in one week from the same series, class, or
  organizer-run program, regardless of exact title. Two different weekly workshop topics at the
  same venue under the same program name (e.g. "Beginner Soldering: Li-Ion Battery Pack" and
  "Beginner Soldering: LED Spinning Top") still count as the same series — judge by the shared
  program, not by whether the titles are byte-identical.

## Venue Elevation

Elevate events at these venues **only as the last step in Tie-Break Precedence above** — they
consistently produce high-alignment picks, but elevation must never override 1–5 of that ordering:
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
