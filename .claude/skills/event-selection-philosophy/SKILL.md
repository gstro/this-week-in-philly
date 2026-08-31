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

This exists because, left unstated, the model resolved ties venue-first. Across four observed weeks
the four heaviest venues took **36 of 84** Top 3 slots (Iffy Books 11, PhilaMOCA 9, Wooden Shoe 9,
Philadelphia Film Society 7), with one venue at a 75–100% hit rate against its candidate count. The
concentration persists, but the *cap* is now holding: 2026-08-03 and -08-10 each had a venue over
the 2-slot cap, while 2026-08-17 and -08-24 had none. **Venue Elevation is the last item in this
list, not a substitute for it** — it may only decide between candidates already
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
- **The Rotunda** — weekly improvised music jam (Wednesdays), Vogue Practice Session (Tuesdays).
  *This deprioritizes those two named weekly series, not the venue.* The Rotunda also appears under
  Venue Elevation below, and both entries are correct: elevate the venue's one-off programming,
  deprioritize its standing weeklies.
- **Hive76** — Open House every Sunday 2:30–5pm *(no `hive76.json` has appeared in any recent week's
  Collection output, though `philadelphia-sources` still lists the source as healthy — this entry
  governs the rare case one appears via another source)*

## Avoid

- Recurring events as a Top 3 pick unless there's a special guest or specific reason to highlight
  this instance. **This spans weeks, not just days.** It was read as a within-week rule for a long
  time and went unenforced in the direction that matters: across five real weeks, 5–24% of Top 3
  slots each week went to an event that had already held one, and "Rustin's Challenge Reading Group"
  took a slot in four consecutive reports. Selection is handed `_recent_picks.json` (recent weeks'
  Top 3 picks) for exactly this check — see `philly-events-selection`'s Phase 3 step 5. A new
  instalment of a series is different content and is fine; the same event again is not.
  **This rule governs Top 3 slots only — it is not a reason to leave a recurring event out of the
  report.** It was read that way, and 0 of 20 recurring candidates across 2026-08-24 and -08-31 were
  listed anywhere: standing museum exhibits, gallery tours, a theatre run, a bluegrass festival.
  Those belong in the report's All Week / Recurring table (see `philly-events-selection`'s Phase 2),
  which costs no listing slot in any day.
- Events at large corporate venues unless the act is truly unmissable
- Events with no verifiable source or unconfirmed details — add *(confirm details)* rather than omitting

## Weekly Patterns

Judged across the **whole week**, not per day — track running totals as you process each day's
candidates in sequence, since these are only visible once more than one day has been picked.

- **Venue repetition: notice it, don't cap it.** There is deliberately **no numeric limit** on how
  many Top 3 slots one venue can take in a week. Across every report published so far, Iffy Books
  took 16 slots, PhilaMOCA 14 and Wooden Shoe 13 — 34% of all Top 3 slots between three venues — and
  that is *not* treated as a defect: they are an anarchist bookstore, a DIY cinema and a radical
  bookshop, which is to say they genuinely program a large share of what Greg cares about. A venue
  is not a proxy for event quality in either direction.

  What to do instead: when several of a week's picks land at one venue, take that as a prompt to
  re-check each one on its own merits — did this event earn the slot, or did it get there because
  the venue is familiar? If it earned it, keep it. **Never drop a better event to even out the
  venues,** and never hold back a strong week from one room in favour of a weaker spread.
  `scripts/check_selection.py` reports per-venue slot counts as a WARN so the pattern is visible
  after the fact; it is an observation, not a rule, and it will never fail a build.
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

Do215 supplies the large majority of candidates most weeks (75–79% across four observed weeks) and
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
- **The Rotunda** — free/PWYW community arts, film, experimental music *(its two standing weeklies
  are deprioritized above; this elevates everything else)*
- **Wooden Shoe Books** — anarchist radical bookstore, readings and community events
- **First Unitarian Church** — Philly's most storied punk/hardcore venue; all R5 all-ages shows
  *(elevate if present — R5 Productions is a healthy source producing candidates every week; it's
  this venue that hasn't come up lately, not the source)*
- **Lightbox Film Center** — premier repertory/arthouse cinema *(elevate if present — not
  currently producing candidates in Collection)*
