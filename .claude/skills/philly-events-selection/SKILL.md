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

**Process all 7 days yourself, sequentially, in this single session. Do not dispatch a subagent per
day, or fan out in any other way.** For each of the 7 dates in the target week, read that day's
`_candidates/<date>.json` one at a time — not the monolithic `_candidates.json`, and not by handing a
day off to a subagent.

This is a deliberate reversal of an earlier assumption, not an oversight: an early run of this task
independently chose to spawn one subagent per day, and it looked like a reasonable way to exploit the
per-day split. Measuring it for real (`scripts/token_report.py` against real session transcripts, same
week processed both ways) showed the opposite of what was expected — fan-out cost **~3x more output
tokens** (189k vs 61k, same 21 top3 picks + 102 annotated candidates) and, even after weighting for
`cache_read` being far cheaper than `cache_write`/output, **~38% more total cost**. Two reasons, neither
fixable from inside this skill: each subagent independently pays to establish its own context (system
prompt, tool definitions, these very skill files) with no sharing between siblings — Claude Code's
context-sharing mechanism (`fork`) is a CLI-only feature, not available to a Routine's own subagent
dispatch — and each subagent's response back to its parent tends to narrate its picks in prose on top of
the compact JSON it's actually supposed to produce. Reading each day's file yourself, in this one
session, avoids both costs entirely.

```
Loaded [N] candidates for [date] ([R] recurring group(s), [F] sources failed during collection).
```

Then read `data/YYYY-MM-DD/_recent_picks.json` **once** — a short list of `{title, venue, week}` for
the Top 3 picks of the recent prior weeks, written by `prepare_selection_input.py`. It exists so you
don't have to open prior weeks' `_selections.json`, which run ~1400 lines each. You'll use it in
Phase 3 step 5.

**If the file is missing, say so and carry on — do not stop.** Collection's
`Prepare selection candidates` step is `continue-on-error: true` by design, so a week can legitimately
have candidates and no `_recent_picks.json`. That is the opposite of the missing-`_candidates.json`
case in Prerequisites, and deliberately so: without candidates there is no week, but without this
file you simply have no cross-week memory this run.

```
Recent picks: [N] from the last [W] week(s). (or: _recent_picks.json not found — skipping the repeat check.)
```

---

## Phase 2 — Score

Apply `personal-interests` weighting to each candidate in the day. Identify high-alignment and
low-alignment candidates qualitatively — **no numeric scores**.

**Trakt.tv releases:** Set venue to `Theatrical release` if none present. Eligible for Top 3 if they
match horror/occult interests.

**Recurring-group candidates** (`recurrence_count` present): a standing museum exhibit, a gallery
tour, a theatre run, a multi-day festival. `recurrence_count`/`occurrences` tells you the series
falls on that many days of this week.

**Annotate these. Do not drop them.** The Avoid rule in `event-selection-philosophy` is scoped to
*Top 3 picks* — a recurring series is a poor Top 3 pick absent a genuinely special occurrence, and
that judgment is yours to make. But it was being read as a reason to exclude them from the report
altogether, and that is wrong: **0 of 20 recurring candidates across 2026-08-24 and -08-31 were
listed anywhere.** Dropped that way: the Michael Jackson exhibit, *Impressionism & Beyond*, Rodin's
Hands, the Esherick tour, *Rent*, the 54th Delaware Valley Bluegrass Festival.

An annotated recurring candidate does **not** compete for a slot in a day's category listing —
`html_render.py` routes it into the report's **All Week / Recurring** table at the bottom instead, one
row per series. So annotating one costs a line, not a listing slot, and a weekly guide that never
mentions what's on at the museums all week is failing at something basic. When in doubt, annotate it.

A recurring series that *is* worth a Top 3 slot (a genuinely special single occurrence) should say so
in its `why`; it then stays in its day rather than moving to the table.

```
Scoring complete for [date]. [E] candidates.
```

---

## Phase 3 — Select Top 3, cap the listing, and write annotations

Apply `event-selection-philosophy` rules for the day:

1. Flag candidates with no verifiable URL as *(confirm details)* — do not exclude
2. Apply Prioritize rules: unique/easy-to-miss, community/political, multi-interest overlap
3. Apply Avoid rules: recurring weekly events (including candidates with `recurrence_count`), large
   corporate venues
4. Enforce the same-series cap across the whole week, not reset per day — keep a running tally, and
   check each Top 3 candidate against every series you've already used on an earlier day, not just
   against today's picks.
5. **Venue repetition: a prompt to re-check, not a limit.** Keep a running tally of `address` values
   too, but there is deliberately **no cap**. If several picks land at one venue, use that as a cue
   to ask whether each one earned its slot on the event itself, or got there because the venue is
   familiar. If it earned it, keep it — Iffy Books, PhilaMOCA and Wooden Shoe genuinely program a
   large share of what Greg cares about, and three venues hold 34% of every Top 3 slot published so
   far without that being a problem. **Never drop a better event to even out the venues**, and never
   trade a strong week from one room for a weaker spread. See `event-selection-philosophy`'s
   "Venue repetition: notice it, don't cap it."
6. **Check every Top 3 pick against `_recent_picks.json` (loaded in Phase 1).** If the same event at
   the same venue already held a Top 3 slot in a recent week, either pick something else or say in
   the `why` what makes *this* instance worth the slot — a special guest, a genuinely notable
   return. This is `event-selection-philosophy`'s "Avoid: recurring weekly events" rule, which spans
   weeks and not just days. It has been the least-observed rule in the file: across five real weeks
   5–24% of Top 3 slots went to content that had already run, and "Rustin's Challenge Reading Group"
   took a slot in **four consecutive reports**. Match on the event, not the series — a new
   instalment (Dekalog Parts 3 & 4 after Parts 1 & 2) is different content and is fine.
7. Exclude online-only candidates from Top 3 unless genuinely exceptional — still eligible for the
   day's category listing
8. Before finalizing a Top 3 pick: search `[event name] Philadelphia [date] postponed` to catch
   cancellations; venue websites are more reliable than aggregators for postponement status
9. Apply `personal-interests`'s Geography section: for any Top 3 pick outside South Philly, Center
   City, or University City, name the neighborhood and the nearest El/BSL/trolley/Regional Rail
   stop or bus in the `why` blurb — treat this as a required field, not a nice-to-have. It is
   working but not yet met: 2026-08-17 landed 4 of 21 blurbs with an access note, and 2026-08-24 —
   the first week after this rule was rewritten against the Point Breeze anchor — landed 7 of 21.
   For a pick outside Philadelphia city limits, this is a high bar (something genuinely
   exceptional), not a default yes — and the `why` must name the travel involved either way.
10. Apply Venue Elevation for tie-breaking, per `event-selection-philosophy`'s Tie-Break Precedence
   — last resort only, never a substitute for 1–8 above
11. Note known Philly-specific recurring events (per `event-selection-philosophy`'s "Recurring Events to
    Deprioritize" list) in listings but not Top 3

For each Top 3 pick, write a `why` blurb: 2–3 sentences explaining what makes this worth attending over
everything else that day. First sentence: what it is and why it's notable. Second: what makes it
specific to this moment or place. Third (optional): the practical case — cost, access, context. Write
with personality and specificity — this text goes directly into the rendered report.

Fewer than 3 qualifying events on a given day is acceptable: if a day's third-best candidate doesn't
clear the bar the first two did — a generic bar special, a recurring weekly with nothing special this
instance, a candidate that only passes because you need a #3 — ship 2, or 1. Don't pad.

That said, **don't go looking for thin days.** Six weeks have now run 3 picks on all 42 days, and two
earlier revisions of this paragraph escalated the wording on the assumption that meant padding. Read
against the actual rank-3 picks, it didn't: bleeding-control training and an offline-GPS workshop at
Iffy Books, Quicksand + Bane, *Dekalog Parts 7 & 8*, a Black queer pop-up, Spike Hellis at Ruba. None
of that is filler — Philadelphia just supplies three good things most days. The rule is here for the
day that genuinely doesn't, not as a target to hit.

**Cap: at most 10 annotated candidates per category per day.** Within each category, keep the 10
highest-alignment candidates by the same qualitative judgment used for scoring — this is a genuine
ranking call within the category, not a new scoring system. **Top 3 picks and honorable mentions are
always annotated regardless of this cap** — if one would otherwise fall outside its category's top 10,
annotate it anyway (a category can end up with 11+ annotated candidates when that happens). The cap
exists so the rendered report's category listings stay readable at ~640 raw events collected most weeks,
not to hide events Greg would want to see — when in doubt, keep the event in.

**In practice this cap has never come close to binding, so don't treat it as a target.** The largest
(day, category) bucket across four measured weeks was 8, and most are 1–3; days run 8–16 listed events
total across all nine categories. If a category genuinely has 10 worth listing on one day, list them.
`html_render.py` caps *display* at 10 as well, and now prints "+ N more not shown" when it does, so
nothing you annotate disappears silently.

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
- `address`: full street address for Google Calendar, on `top3` entries only. Candidates as you see them
  never carry an address — this is written from your own knowledge of the venue, same as `why`.

  **Omit it rather than guess.** A wrong address is worse than a missing one: it becomes the Google
  Calendar entry's location and sends Greg to the wrong place, while a missing one just leaves the
  entry unpinned. This is not hypothetical — the 2026-08-31 report put Cherry Street Pier at "301 S
  Christopher Columbus Blvd" (it's at 121 N), about a mile off, and gave the same invented address to
  Spruce Street Harbor. If you're confident, write it; if you're reconstructing it from a venue name
  you don't actually know, leave it out.

  For a few sources Collection does capture the venue's real address, and `merge_selections.py` fills
  it in when you omit one — and prefers it over yours when both exist, reporting any disagreement.
  That data is deliberately kept out of your per-day files: it would double their size, and your
  address is more useful as an independent check on the source's than as an echo of it.
- `honorable_mentions`: id only — 2–3 max per day, omit array if none.
- `why`: 2–3 sentences for Top 3 picks only — more substantial than `note`.
- `note`: 1–2 sentences, on `annotations` entries — carry from the candidate's `description` if useful,
  otherwise write fresh. Omit the field entirely if there's genuinely nothing useful to add beyond
  title/venue/time (`html_render.py` already treats a missing `note` as fine).
- `time`: **omit this field on a top3 pick** unless the candidate's own `time` needs cleanup — the merge
  step copies the candidate's `time` through verbatim by default. Only include it as an override when the
  candidate's `time` is a list, a doors/show pair, or a range rather than **a single, cleanly parseable
  start time** (`H:MM AM/PM`, e.g. `"7:00 PM"`) — write ONE clean representative start time here and
  describe the rest as prose in `why` (e.g. "Doors 6:00 PM, show at 7:00 PM."). Actually check the
  candidate's raw `time` for every Top 3 pick before moving on — don't assume it's clean. This matters
  specifically for Top 3 picks: `calendar_create.py`'s `parse_start()` only matches a single `%I:%M %p`
  string, and a malformed `time` means that pick's calendar event silently never gets created — confirmed
  twice on real weeks (5 of 21 picks on 2026-08-03; 2 of 21 on 2026-08-17, that time from an omitted
  override rather than a bad value). **`merge_selections.py` now fails the entire week's merge — no
  report publishes — if a Top 3 pick's resolved `time` isn't a single clean `H:MM AM/PM` value**, so this
  is no longer a silent degradation to catch after the fact; get it right here or the push doesn't make
  it to a report. Not applicable to plain `annotations` entries — there's no override field there, and a
  messy `time` in the category listing is cosmetic, not a silent failure (`html_render.py` just displays
  it as-is).

```
Selection complete for [date]. [N] top3, [M] annotated, [K] categories capped.
```

---

## Phase 4 — Self-check

Once all 7 days are processed, before assembling the final file, print a short summary so drift is
visible to you (and to whoever reads the run) at authoring time, when it can still be acted on —
`scripts/check_selection.py` re-checks these and a few other things mechanically after this task
pushes, but that only fires in CI; this catches it here first:

```
Self-check for week of [YYYY-MM-DD]:
  Venues (top3, by address): [address]: [count], [address]: [count], ...
  Categories (top3): [category]: [count], ...
  Sources (top3, by origin `source` field): [source]: [count], ...
  Top 3 picks with no address: [N]
  *(confirm details)* flags: [N]
```

This is informational, not a gate — nothing here blocks the push, and there is **no venue count that
is too high**. If one venue holds several slots, re-read those picks and confirm each earned its slot
on the event itself (Phase 3 step 5); if they did, that is a good week, not a problem to fix.

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
