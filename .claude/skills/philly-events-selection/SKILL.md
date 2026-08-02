---
name: philly-events-selection
description: Selects Philadelphia's Top 3 events per day from Collection's output and writes the why blurbs. Use this skill when running the weekly Selection stage of the This Week in Philly pipeline, after Collection has produced a week's per-day _candidates/<date>.json files. Reads personal-interests and event-selection-philosophy for judgment; writes _selection_annotations.json for a GitHub Actions merge step to turn into _selections.json.
output_directory: data
---

# Philadelphia Events — Selection Task

**Schedule:** Sunday mornings, ~30 minutes after Collection's own cron (v1's original cadence — this
task's Routine runs on its own schedule, not an event pushed from Collection; see the guard below).
**Input:** `data/YYYY-MM-DD/_candidates/<date>.json` — one file per day, written by
`scripts/prepare_selection_input.py --split-by-day` as a `collection.yml` step, alongside the rest of
Collection's output.
**Output:** `data/YYYY-MM-DD/_selection_annotations.json` — the judgment calls only (category, sold_out,
note, why, rank, is_music, address, and an optional `time` override), keyed by each candidate's `id`.
A GitHub Actions step
(`scripts/merge_selections.py`, run by `presentation.yml`) reconstructs `_selections.json` from this
plus `_candidates.json` — this task never writes `_selections.json` itself.

Adapted from `docs/v1/Scheduled/philly-events-selection/SKILL.md` (kept as historical reference, not
updated) for v2: repo-relative paths instead of the v1 iCloud path, and Phase 2 (Deduplicate) removed
entirely — it's now fully owned by `prepare_selection_input.py`, since v1's own dedup rule was already
mechanical. This task starts at scoring.

**Why annotations instead of a full rewrite:** re-typing every candidate's title/venue/time/cost/url/
source into `_selections.json` cost roughly 32k output tokens per run for data you were just handed —
measured on the real 2026-08-03 week. It also caused a real bug: 62 of 562 events silently drifted from
their candidate because a title got reworded in transit, breaking the ⭐/Spotify/calendar lookups that
key off exact title match. Referencing a candidate by its stable `id` instead of retyping it structurally
prevents both.

---

## Read first

1. `.claude/skills/personal-interests/SKILL.md`
2. `.claude/skills/event-selection-philosophy/SKILL.md`

Always select for the full week: **the Monday immediately following today through the Sunday after
that** (i.e., the upcoming 7-day window starting tomorrow). Compute the date range from today's date
at runtime.

The nine canonical `category` strings, in report display order (also `common.CATEGORY_ORDER` — stated
here so this task never needs to open `events-report-format/SKILL.md` just to sort):

1. `🎵 Music & Concerts`
2. `🎬 Film & Cinema`
3. `📚 Literary`
4. `🤝 Community & Politics`
5. `🎨 Arts & Workshops`
6. `💻 Tech & Maker`
7. `🌿 Markets & Outdoors`
8. `👻 Horror & Occult`
9. `🎪 Festivals & Major Events`

---

## Prerequisites

Verify `data/YYYY-MM-DD/_candidates.json` exists for the target week (Collection always runs
`prepare_selection_input.py --split-by-day` alongside it, so the per-day files under
`data/YYYY-MM-DD/_candidates/` exist too whenever this does). If missing:

```
Collection has not produced usable candidates for this week. Check collection.yml's most recent run
before re-triggering Selection.
```

This is the safety net for a silent Sunday: this task's own Routine runs on a fixed schedule rather
than being triggered by Collection's completion, so it must be able to tell "Collection hasn't run
yet or failed" from "Collection ran and there's real data" on its own.

If `_selection_annotations.json` already exists for this week, **stop and notify — do not overwrite
without confirmation.** Re-running Selection against an already-selected week is very likely a mistake,
not a retry.

---

## Phase 1 — Load

For each of the 7 dates in the target week, read that day's `_candidates/<date>.json` — not the
monolithic `_candidates.json`. Each per-day file's `candidates` array is a subset of the same
already-flattened, exact-duplicate-collapsed, recurring-grouped list `_candidates.json` carries (every
event tagged with `source` and a stable `id`); a recurring listing (`recurrence_count` present) appears
only in its earliest occurrence's day file, same as it appears only once in the full week's file.
`collection_failures` is repeated on every per-day file, already in the shape the final output needs.

If your Routine session dispatches a subagent per day (an established pattern this task's own runs have
already converged on), each subagent should read only its own day's file — that's the whole point of the
split. If processing all 7 days in one session, read them one at a time rather than falling back to the
monolithic `_candidates.json`.

```
Loaded [N] candidates for [date] ([R] recurring group(s), [F] sources failed during collection).
```

---

## Phase 2 — Score

Apply `personal-interests` weighting to each candidate in the day. Identify high-alignment and
low-alignment candidates qualitatively — **no numeric scores**.

**Trakt.tv releases:** Set venue to `Theatrical release` if none present. Eligible for Top 3 if they
match horror/occult interests.

**Recurring-group candidates** (`recurrence_count` present): this is exactly the case
`event-selection-philosophy`'s "Avoid: recurring weekly events... unless something special is
occurring" rule exists for. `recurrence_count`/`occurrences` tells you the series repeats this many
times this week — apply the judgment yourself; the annotation is a signal, not a verdict. A recurring
series that's still worth a Top 3 slot (a genuinely special single occurrence) should say so in its
`why` blurb.

```
Scoring complete for [date]. [E] candidates.
```

---

## Phase 3 — Select Top 3, cap the listing, and write annotations

Apply `event-selection-philosophy` rules for the day:

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

**Cap: at most 10 annotated candidates per category per day.** Within each category, keep the 10
highest-alignment candidates by the same qualitative judgment used for scoring — this is a genuine
ranking call within the category, not a new scoring system. **Top 3 picks and honorable mentions are
always annotated regardless of this cap** — if one would otherwise fall outside its category's top 10,
annotate it anyway (a category can end up with 11+ annotated candidates when that happens). The cap
exists so the rendered report's category listings stay readable at ~640 raw events collected most weeks,
not to hide events Greg would want to see — when in doubt, keep the event in.

**Write your day's contribution** in this shape (an in-progress `_selection_annotations.json` — see
"Assemble and write" below for the full-week file):

```json
{
  "date": "2026-06-08",
  "day_name": "Monday",
  "top3": [
    {
      "id": "c0042",
      "rank": 1,
      "address": "2125 Chestnut St, Philadelphia, PA 19103",
      "category": "🎵 Music & Concerts",
      "is_music": true,
      "sold_out": false,
      "why": "Saetia reunite for a rare one-night benefit show for Juntos Philadelphia — hardcore royalty with a reason beyond the music. They haven't played Philadelphia since 2019 and this is the only East Coast date. $15, all ages, First Unitarian."
    }
  ],
  "honorable_mentions": [
    { "id": "c0107" }
  ],
  "annotations": [
    {
      "id": "c0042",
      "category": "🎵 Music & Concerts",
      "sold_out": false,
      "note": "Rare reunion show, only East Coast date. Benefit for Juntos Philadelphia."
    },
    {
      "id": "c0107",
      "category": "🎬 Film & Cinema",
      "sold_out": false,
      "note": "Monthly repertory film night at the Rotunda — free, no RSVP required."
    }
  ]
}
```

**Field notes:**
- `id`: the candidate's `id` from its `_candidates/<date>.json` entry — never invent one, never carry an
  id from a different day's file.
- `category`: one of the nine canonical strings listed under "Read first" — exactly, do not invent
  variants.
- `annotations`: **every** candidate you're including in the day's report — this is what becomes the
  category listing (`events[]` in the final `_selections.json`). **Every `top3` id and every
  `honorable_mentions` id must also have an entry here** — the merge step (`merge_selections.py`) fails
  loudly if one doesn't, because that pick would otherwise have no card in its category's listing.
- `is_music`: **always include on a top3 pick, `true` or `false`** — true for any pick where a Spotify
  artist page lookup makes sense. Not written for plain `annotations` entries — nothing downstream reads
  it there. (Omitting it merges as `false` rather than failing, but don't rely on that — write it
  explicitly.)
- `sold_out`: **always include, `true` or `false`**, on both `top3` picks and `annotations` entries — true
  if any source flagged the event as sold out (check the candidate's `description` in the per-day file —
  `prepare_selection_input.py` preserves a sold-out mention found on a discarded duplicate as a
  `[Note: ...]` prefix, since there's no structured sold-out field at Collection's stage). Still include
  the event if worth attending; sold-out is a note, not an exclusion. A sold-out honorable mention gets a
  `(SOLD OUT)` suffix on its title automatically (bolded by the render step) — don't add the suffix
  yourself.
- `address`: full street address for Google Calendar, on `top3` entries only; omit if unknown. Candidates
  never carry an address (Collection's event schema has no address field) — this is written from your own
  knowledge of the venue, same as `why`.
- `honorable_mentions`: id only — 2–3 max per day, omit array if none.
- `why`: 2–3 sentences for Top 3 picks only — more substantial than `note`.
- `note`: 1–2 sentences, on `annotations` entries — carry from the candidate's `description` if useful,
  otherwise write fresh. Omit the field entirely if there's genuinely nothing useful to add beyond
  title/venue/time (`html_render.py` already treats a missing `note` as fine).
- `time`: **omit this field on a top3 pick** unless the candidate's own `time` needs cleanup — the merge
  step copies the candidate's `time` through verbatim by default. Only include it as an override when the
  candidate's `time` is a list, a doors/show pair, or a range rather than **a single, cleanly parseable
  start time** (`H:MM AM/PM`, e.g. `"7:00 PM"`) — write ONE clean representative start time here and
  describe the rest as prose in `why` (e.g. "Doors 6:00 PM, show at 7:00 PM."). This matters specifically
  for Top 3 picks: `calendar_create.py`'s `parse_start()` only matches a single `%I:%M %p` string, and a
  malformed `time` means that pick's calendar event silently never gets created — confirmed on the real
  2026-08-03 week (5 of 21 Top 3 picks lost their calendar entry this way). Not applicable to plain
  `annotations` entries — there's no override field there, and a messy `time` in the category listing is
  cosmetic, not a silent failure (`html_render.py` just displays it as-is).

```
Selection complete for [date]. [N] top3, [M] annotated, [K] categories capped.
```

---

## Assemble and write

Once every day (Monday through Sunday) has been processed, combine all 7 days' contributions into one
`data/YYYY-MM-DD/_selection_annotations.json`:

```json
{
  "week": "2026-06-08",
  "collection_failures": ["free-library (Cloudflare bot-check)"],
  "days": [ /* the 7 per-day objects from Phase 3, Monday first */ ]
}
```

- `week`: the target week's Monday (matches `_candidates.json`'s `week`).
- `collection_failures`: copy through unchanged from any one day's file (identical on every per-day
  file).
- `days`: all 7 days, even a day with an empty `top3` (fewer than 3 qualifying events is acceptable —
  see Phase 3).

```
Selection complete. Top 3 written for [N]/7 days. _selection_annotations.json saved.
```

---

## Commit and push

```
git add data/YYYY-MM-DD/_selection_annotations.json
git commit -m "Selection: week of YYYY-MM-DD"
git push
```

This push is what fires `presentation.yml` (`on: push`, `paths: ['data/**/_selection_annotations.json']`)
— no API call, no webhook, no separate trigger. `presentation.yml`'s first step runs
`scripts/merge_selections.py`, which reconstructs `_selections.json` from this file plus
`_candidates.json` before the rest of the pipeline (Spotify lookup, HTML render, calendar create) runs.

---

## Stop

Do not proceed to merging, Spotify lookup, or rendering. Those run in GitHub Actions
(`presentation.yml`'s merge step and `scripts/runner.sh`), invoked by this push.
