# HTML Report Improvements — Brainstorm

## Context

The Presentation stage (`scripts/html_render.py` + `templates/report.html.j2`) now
produces a working weekly report on GitHub Pages. It is faithful to
`docs/v1/Skills/events-report-format/SKILL.md` and byte-pinned by a golden test — but
it is still a straight port of the v1 layout, and the pipeline underneath it has changed.

Two facts from the published artifacts drive most of this list:

| Week | Raw | Candidates | Events listed | Top 3 | Rendered HTML |
|---|---|---|---|---|---|
| 2026-06-22 | — | 90 | 88 | 21 | 75 KB |
| 2026-08-03 | 642 | 561 | **486** | 21 | **300 KB** |

**Superseded call:** an earlier pass through this document treated August as a one-off
upstream artifact (Do215 gaining a real JSON API — see `data/expected_yield.json`) and
recommended June's ~90-event shape as representative. **Greg has since decided the
opposite: treat August's volume as the new normal**, with density handled by a
render-side change — the next run will cap each category to at most **10 rendered
cards**, applied *per day* (see §2's new subsection for why per-day, not per-week,
matters here). That cap doesn't fully collapse the page: capping 2026-08-03 to 10
cards/category/day would still render **327 of its 486 event cards** (a 33% cut,
concentrated in Music and Arts — see the worked numbers below). So density tooling in
§3 is re-scored against "large volume, capped display," not against June's small shape.

What remains true at *any* size: no navigation, no dark mode, no working responsive
layout, a sources footer that misstates which sources contributed, and several fields
carried all the way to Presentation and then dropped.

Separately, Greg proposed a **Stats section** (waffle chart per category: gray =
captured-not-selected, white = selected-not-top3, gold = top3, with hover detail).
That's the seed for this document; §2 works through what the data actually supports.

---

## 1. Cross-cutting constraints

1. **The golden test pins the output byte-for-byte.**
   `tests/test_html_render.py::test_render_report_matches_the_golden_v2_artifact` pins
   `tests/golden/actual-2026-06-22.html`. *Any* template change breaks it and requires
   regenerating that file and reviewing the diff. Flat per-change cost, not per-idea —
   but it means "small cosmetic tweak" is never free here.
2. **`events-report-format/SKILL.md` is the spec of record.** `html_render.py`'s module
   docstring documents every deliberate divergence. Ideas below are tagged
   **[additive]** (spec silent) or **[spec change]** (needs a SKILL.md edit in the same
   change, per repo convention). Note there are **two copies** of that spec
   (`docs/v1/Skills/…` is the record; `.claude/skills/…` already diverges on the footer
   source list) — a spec change must decide which to edit, or both.
3. **`html_render.render_report()` reads exactly two files** — `_selections.json` and
   `_spotify.json` — and passes four variables to the template. Everything else in
   `data/` sits in the Actions checkout but needs a new load. That's the dividing line
   between Tier A and Tier B below.
4. **Numeric scores are explicitly forbidden.** Both copies of the Selection skill say
   "Identify high-alignment and low-alignment candidates qualitatively — **no numeric
   scores**." So no "match score" gauges, ever. Counts and ratios are fine; scores are not.
5. **Delivery is GitHub Pages only** (`https://gstro.github.io/this-week-in-philly/weeks/YYYY-MM-DD.html`).
   No Drive, no Gmail, no email — v2's Google auth is Calendar-only. Email-client HTML
   compatibility is therefore *not* a constraint.

   **On JS specifically:** GitHub Pages imposes no restriction here. It is a plain static
   file host; it serves whatever bytes are in `docs/` and the browser executes any
   `<script>` in them exactly as it would from any other host. Pages only forbids
   *server-side* execution (no PHP, no Jekyll plugins outside the allowlist) — client-side
   JS has always been fine, and Jekyll processing is bypassed entirely here anyway.

   So the JS question is a **durability and taste** call, not a hosting one. The real
   tradeoffs: inline JS keeps each archived week self-contained and still works offline
   from a saved file, but it adds behavior that can rot silently and that no test
   currently covers (the golden test pins bytes, not behavior); and any filter UI must
   degrade to "everything visible" when JS is off, or a JS error hides the whole report.
   A safe rule: **progressive enhancement only** — the report must be complete and
   readable with JS disabled, with JS adding filtering/collapsing on top.
6. **Source strings are dirty free text.** Real values in `_selections.json`:
   `"Do215 / WXPN"`, `"Do215, WXPN"`, `"PhilaMOCA / Do215"`,
   `"Do215 / Philly Ask A Punk / WXPN"`. Any by-source aggregation needs a normalizer
   (split on `/` and `,`, trim) first.
7. **Self-containment is emergent, not mandated.** The report has zero `<script>`,
   `<link>`, or `<img>` tags and one inline `<style>` block — but the spec never
   *requires* that. Nothing today would stop a CDN font or iframe creeping in. Worth
   making it an explicit rule while touching the template, since it's what makes every
   archived week self-contained and diffable.
8. **Spec rules that constrain content ideas:** `why` blurbs render verbatim ("do not
   rewrite them"); Top-3 events in the category listing use `note`, not `why`; honorable
   mentions are 2–3 max; empty categories are omitted; within a category events are
   chronological; online-only events get `(Online)` appended to the venue.

---

## 2. The Stats section — what the data actually supports

### The blocker on the literal waffle

`_candidates.json` events have exactly these keys:
`title, venue, date, time, cost, url, description, source` (+ `occurrences` /
`recurrence_count` on 19 of 561).

**There is no `category`.** Category is assigned by Selection and only exists on events
Selection promoted into `day.events`. So "gray square per captured-but-not-selected
event, per category" **cannot be built from current data**. Three ways out:

| Option | What you get | Cost |
|---|---|---|
| **A. Drop the gray tier** | Per-category waffle: white = listed, gold = top3 | Works today from `_selections.json` alone |
| **B. Gray as one uncategorized total** | Waffle + a "561 captured → 486 listed" headline | `render_report()` also loads `_candidates.json` |
| **C. Selection categorizes all candidates** | The literal chart as described | `_selections.json` schema change + Selection Routine change + more Sonnet tokens/week |

### The sharper problem with the waffle as conceived

For 2026-08-03 the funnel is **561 → 486 → 21**. The gray tier would be 13% of the
total; the chart would be ~87% white. **Captured→listed is not where the signal is.**

The signal is in **listed → top3, per category** — how hard a category has to work to win
a slot. And the strongest argument for it is that **the answer inverts between the two
published weeks**:

| Category | Jun 22 listed% → picks% | Aug 3 listed% → picks% |
|---|---|---|
| 🎵 Music | 38.6% → **57.1%** (over-picked) | 35.4% → **19.0%** (under-picked) |
| 🎬 Film | 21.6% → 9.5% | 7.6% → 19.0% |
| 🎨 Arts | 8.0% → **0%** | 22.4% → 9.5% |
| 🌿 Markets | 2.3% → 0% | 14.4% → 4.8% |

Some of that is the Do215 firehose distorting August. But the June week alone shows real
information: Music took 12 of 21 slots off 34 listings while Arts, Horror, and Markets
took **zero**. That's not visible anywhere in the report today, and it's a genuine
feedback signal on whether Collection's effort is aimed where Selection's judgment
actually lands. A waffle chart renders it legibly; nothing else in the report does.

The second stat worth the space is **by source**: Do215 alone is **381 of 486** listed
events. That's a concentration and fragility fact worth seeing weekly — if Do215 breaks,
the report is gutted.

**Recommendation:** build option A, and pair it with the source-concentration bar.

### Revised: a per-category waffle normalized to a fixed total is the wrong form

(Flagged by Greg.) A waffle capped to ~10 squares per category collapses two different
jobs into one grid: *how big is this category* (magnitude) and *what fraction won a
slot* (part-to-whole). Squashing nine wholes that range from 2 to 34 listed events into
the same 10-box frame erases the magnitude story, and the ratio story thins out too —
0-of-2 and 0-of-7 both round to "0 gold of ~10," hiding the fact that one category barely
had any candidates. Real June numbers: Music 34→12 (35%), Film 19→2 (11%), Tech 8→2
(25%), Arts 7→0, Community 6→2 (33%), Literary 5→2 (40%), Horror 4→0, Festivals 3→1
(33%), Markets 2→0. Capped-to-10, all nine grids look like minor variations on the same
sparse pattern; the 17x spread between Music and Markets disappears.

**Revised recommendation:** a **sorted horizontal bar/meter list**, not a waffle. Bar
length ∝ actual listed count (Music's bar ~5x Tech's, honestly); a gold segment/cap at
the end marks how many became Top 3. One glance shows scale and hit-rate together — a
long bar with a thin gold sliver (Film) reads differently from a short bar that's a
third gold (Festivals), and zero-pick categories show as bars with no gold at all, at
their true length. Also cheaper to build in the current no-JS, inline-CSS template than
nine separate grids.

If the square aesthetic is still wanted, the fallback is an **uncapped** unit-square
grid — true count per category, uniform small squares, sorted descending, wrapped at a
fixed row width rather than a fixed total — which keeps per-square hover but doesn't
force categories into artificial parity. Watch for the case where one category's real
count dwarfs the page (the August Do215 firehose would have); cap *display width* with
a "+N more" label if that recurs, never the count itself.

### The 10-card-per-category cap: true counts survive it for free, but naive truncation doesn't

**Category grouping happens per day, not per week.** `build_categories()` in
`html_render.py:172` runs once inside the per-day template loop — so "Music has 172
listed events this week" is actually spread across 7 separate day-sections, and the cap
(discussed above, "10 rendered cards per category") applies **per day×category cell**,
not once per category for the whole week. For 2026-08-03 that's 63 cells, of which
**16 exceed 10** — Friday Music (51), Saturday Music (44), Thursday Music (26), Saturday
Arts (26), and 12 more, mostly Music, Arts, and Markets on the busy days.

**Whether this needs new Selection work: no.** Selection already assigns `category` to
every one of the 486 listed events today — that's not new categorization, it's the
categorization Selection already performs. The per-category totals used for a stats
chart (172 Music, 109 Arts, …) are already sitting in `_selections.json`, summable with
`Counter()` at zero token cost, regardless of whether cards get capped for display. The
only way true counts would be lost is if the cap were implemented by having *Selection*
stop writing more than 10 events per category into `_selections.json` — which would also
need Selection to emit a small `category_counts` tally alongside the trimmed list (cheap,
since it's already iterated the full set to build it) and would be a schema change
requiring a SKILL.md update. **The cap should live in Presentation only** — `_selections.json`
stays exactly as it is today; `html_render.py` truncates the display, and a stats chart
reads the pre-truncation length. Zero schema change, zero token cost, zero SKILL.md edit.

**Naive truncation is a real bug, not a hypothetical one.** `build_categories()`'s
current sort key is purely chronological (parsed start time, ties by original order —
no quality signal at all). Slicing "the first 10" of that order means "whichever 10
start earliest," with no relationship to what Selection actually judged worth attention.
Checked against this week's real data: **cutting Friday's 51 Music listings to the
first 10 by start time would cut an actual Top 3 pick** — "The Body, with BIG|BRAVE,
Carnivorous Bells" — because 10 earlier-starting shows sort ahead of it. This is not
edge-case reasoning; it's what would ship if the cap were implemented as a plain
`events[:10]` slice.

**Resolved design: priority-sort before slicing, not `events[:10]`.** Sort each
category's per-day list by: (1) Top 3 picks for that day (`top3_titles`, already
computed), (2) Honorable mentions for that day (matched by title/venue against the
day's events, since HM entries carry no `category` of their own — the same kind of
lookup `html_render.py` already does for Top 3), (3) everything else, chronological.
Slice to 10 *after* that sort. This guarantees the cap can never hide something
Selection already vetted, at zero additional Selection or token cost — it's a sort-key
change in `build_categories()`, nothing more.

**What this does not fix:** for the undifferentiated remainder in a heavy cell (Friday
Music's other ~41 non-Top3/HM listings), there is no existing quality signal — Selection
deliberately doesn't rank or score beyond Top 3/HM. Any 10 chosen from that bucket are
equally arbitrary; the priority-sort fix doesn't make that pool "smart," it only
guarantees the picks that matter can't become collateral damage. Making the remainder
non-arbitrary too would mean Selection producing a real per-category ranking — a
genuine token increase (bounded, since the full candidate read already happens for Top
3 today; the marginal cost is in *output*, not re-reading), and worth treating as a
later escalation rather than part of this cap.

### One thing to decide before any counter renders

**There are three disagreeing event counts for the same week:** `raw_event_count` **642**
→ `total_events_after_dedup` / candidates **561** → rendered `days[].events[]` **486**.
Selection silently drops 75 candidates that reach no day array. Any "N events this week"
tile has to pick one, and they disagree by ~24%. Pick the rendered count (486) as the
headline — it's the only one the reader can verify by scrolling — and show the others as
the funnel, not as the number.

### Stats-section candidate charts

| # | Chart | Data source | Rationale |
|---|---|---|---|
| 1 | **Category magnitude+ratio, listed vs top3** | `_selections.json` | Greg's waffle idea, revised: a sorted horizontal bar/meter (length = listed count, gold segment = top3), not a per-category waffle capped to a fixed total — see the revision note below the funnel discussion for why. Must read the **true, pre-cap** per-category counts (summed across all 7 days), not the capped display count — see "The 10-card-per-category cap" below. Hover shows title/venue/time. Best single chart here. |
| 2 | **Source contribution bar** | `_selections.json` (normalized) | Surfaces the Do215 monoculture (381/486). Most decision-relevant stat in the set. |
| 3 | **Collection health strip** | `_manifest.json` | 23 sources, per-source counts, failure reasons, run duration from `run_started`/`run_completed`. Turns silent scrape rot into a visible weekly number. |
| 4 | **Zero-yield sources** | `_manifest.json` | **7 of 23 sources returned `status: ok, events: 0`** this week (lightbox, 5 Meetup groups, philly-shows). They look healthy and contribute nothing — invisible today. |
| 5 | **Yield vs. expected floor** | `data/expected_yield.json` | Already exists: hand-maintained per-source `min_expected` + `total_floor: 45`, consumed by `check_yield.py`. A ready-made "under floor this week" stat with no new data modelling. |
| 6 | **Free vs paid split** | `cost` + `common.is_free_cost` | Greg's philosophy leans free/DIY; this checks the report against it. |
| 7 | **Day density** | `_selections.json` | Mon 41 → Sat 111. Shows at a glance where the week is heavy. |
| 8 | **Time-of-day histogram** | `time` field | Most events cluster at 7–8 PM; visualizing conflict density is genuinely useful for planning. |
| 9 | **Venue leaderboard** | `venue` | "Top venues this week" doubles as a scene-health read. |
| 10 | **Sold-out count** | `sold_out` | Cheap urgency signal; currently only visible inline per card. |
| 11 | **Price histogram** | parse `$` from `cost` | `csv_log.infer_price_tier`'s regex already extracts `$N`. Lower confidence — cost is free text (`"$16-$20, 21+"`, `"Free with museum admission."`, `"21+"`, `""`). |
| 12 | **Spotify match rate** | `_spotify.json` | Only 4 of 21 picks were `is_music` this week, 2 matched. Low-value alone; useful inside #3. |
| 13 | **Category mix vs interest weights** | `personal-interests` skill | Ambitious: does the listed mix match Greg's stated weights? Needs the weights encoded as data, not prose. |
| 14 | **Week-over-week deltas** | scan `data/*/` | "+398 events vs June", "Do215 share 79%". Needs a stable historical read; only 2 weeks published so far. |
| 15 | **Attendance history** | picks-log CSV | **Blocked** — see §5. |

---

## 3. Density and navigation

> **Status update (from Greg), second revision:** August's volume is now the assumed
> baseline, not a one-off — Do215's API is a lasting source of ~500+ raw events, not a
> blip. Density is handled on the render side: **each category caps at 10 rendered
> cards per day** (see §2's subsection). That cap is a genuine mitigation but not a full
> fix — 2026-08-03 would still render **327 of 486 cards**, and the heaviest cells
> (Friday/Saturday Music, Saturday Arts) stay large even after the cut. So this section
> is re-scored a third time: against "large true volume, moderately capped display," not
> against June's ~90-event shape and not against an uncapped 486.
>
> Net effect versus the previous (June-shape) scoring: the wayfinding items (#21, #22,
> #23) were already kept regardless of size and still stand. **#20 (collapse past N) is
> superseded** — it's no longer a separate idea, it's what the cap in §2 *is*. The
> heavier items (#16, #17, #18, #19, #24) are worth a second look now that real density
> is back, scored below against the capped (not raw) page shape.

| # | Idea | Tag | Verdict against the capped Aug-shape page |
|---|---|---|---|
| 21 | **Counts in day + category headers** | additive | **Worth it, more so now.** Should show the *true* count, not the capped one — `🎵 Music & Concerts (10 of 51 shown)` — otherwise the cap silently hides that 41 events aren't there. Zero-JS, feeds the stats section for free. |
| 22 | **Per-day anchor links** (`#saturday`) | additive | **Still worth it.** Linkable at day granularity, independent of density either way. |
| 23 | **Top-of-page TOC with counts** | additive | **Still worth it, zero-JS.** More valuable now that per-category true counts vary 2–172 across the week — the TOC is the one place that can show real scale before any capping happens. |
| 16 | **Sticky day nav** | additive | **Reconsider.** 327 capped cards is still a substantial scroll (vs. June's 88). Worth building alongside #23 rather than dropping — the two aren't mutually exclusive. |
| 24 | **Back-to-top button** | additive | **Reconsider, low cost.** Page is smaller than the uncapped 486-card version but still meaningfully longer than June's; cheap to include. |
| 17 | **Category chip filters** (JS) | additive | **Still defer.** Real per-category counts (13–172) would make filters more useful than at June's small scale, but the cap already does most of the work of keeping any single view manageable. Revisit only if the cap alone feels insufficient in practice. |
| 18 | **"Free only" / "evening only" toggles** | additive | **Still defer**, same reasoning as #17. |
| 19 | **Text search box** | additive | **Still drop.** Ctrl-F covers a single-file page at any of these sizes. |
| 20 | **Collapse categories past N** | spec change | **Superseded, not dropped.** This is now literally what the 10-card cap in §2 implements — not a separate idea to revisit, just cross-reference it there. |
| 25 | **Split into per-day pages** | spec change | **Rejected** regardless of density — breaks the single-file archive property and Ctrl-F. Listed for completeness. |

---

## 4. Card and content improvements

### Presentation quality

| # | Idea | Tag | Rationale |
|---|---|---|---|
| 26 | **Dark mode** | additive | `templates/index.html.j2` has a `prefers-color-scheme` block; `report.html.j2` has **zero** `@media` queries of any kind. Inconsistent, and the report is read on a phone at night. |
| 27 | **Mobile layout fix** | additive | `.event-right { min-width: 120px }` and `.pick-meta { min-width: 130px }` in flex rows squeeze the title column badly under ~380 px. The report has a viewport meta tag but no media queries — *declared* responsive, not actually responsive. |
| 28 | **Print stylesheet** | additive | Dark `#1c1c1c` Top-3 cards print as solid ink blocks. |
| 29 | **Accessibility pass** | spec change | Several real failures: `.pick-why` is `#999` on `#1c1c1c` (~3.5:1, fails WCAG AA); day and category headers are `<div>`s, so there's no heading outline for screen readers or reader-mode; body type runs to 0.62rem (~10px); no skip link; no visible focus styles; category emoji unlabeled. |
| 30 | **Semantic `<time datetime>`** | additive | Machine-parseable, and improves screen-reader reading of "7:00 PM". |

### Surfacing data already present but discarded

| # | Idea | Tag | Rationale |
|---|---|---|---|
| 31 | **Map links from `address`** | additive | Top-3 picks carry `address` (`"530 South St, Philadelphia, PA 19147"`, present on 20/21) — **rendered nowhere**. Free geography for the three events Greg is most likely to attend. Note this is the *only* geo data in the system: there are no coordinates or neighborhood fields at any stage, and non-Top-3 events have no address at all. |
| 32 | **Derive the sources footer from the week's data** | spec change | The footer is a **hardcoded 16-entry list** in `html_render.py:77` — it lists sources that contributed nothing this week and omits ones that did. Every event carries `source`; the footer could show actual contributors with counts, and grey out the silent ones. Fixes a footer that currently misrepresents the week. |
| 33 | **Per-event source attribution** | spec change | `source` is on all 486 events and never displayed. Useful for trusting or discounting a listing. |
| 34 | **Footer provenance line** | additive | `generated_at` and `total_events_after_dedup` are loaded and rendered nowhere. Add run time, counts, sources OK/failed. Currently only failures show. |
| 35 | **`.ics` download per pick** | additive | Greg gets Top 3 in Google Calendar already, but nothing else is calendar-able. A data-URI `.ics` per card needs no server. Duration heuristics already exist in `calendar_create.py` (film +2h, music +3h, etc.). |
| 36 | **Sold-out styling on Top 3** | additive | Listed events get `.sold-out` red; Top-3 picks render `time_cost` as plain text with no sold-out treatment, despite `sold_out` being on every pick. Inconsistent. |
| 37 | **Link honorable mentions** | spec change | HM entries are `{title, venue}` only — no `url`. Needs the Selection schema to carry one. Currently the only dead-end text in the report. |
| 38 | **Recurrence badge / restore the All Week table** | spec change | Strongest item in this section. `prepare_selection_input.py` already computes `occurrences`/`recurrence_count` (19 of 561 candidates), but those keys **do not survive into `_selections.json`** — the information dies at the Selection boundary. Restoring them is the only way to close a **real spec gap**: `events-report-format/SKILL.md:107` *requires* a `📅 All Week / Recurring` table that v2 omits precisely because no recurrence field reaches Presentation. Its CSS still sits unused in the template. |
| 39 | **Multi-artist Spotify links** | spec change | Documented gap (`tests/golden/README.md`): `_spotify.json` is one match per title, so a two-act bill links one act. Low urgency — only 4 of 21 picks were music this week. |
| 40 | **Spotify embed for Top-3 music picks** | additive | An `<iframe>` player breaks self-containment (constraint #7) — a tradeoff, not a recommendation. |
| 41 | **Reconcile template/spec drift** | spec change | `.sold-out` (`#c0392b`) and `.pick-name a.event-link { color: #fff }` exist in the template but nowhere in SKILL.md; the footer lists 16 sources where the spec says 21. Cheap housekeeping to fold into whatever lands first. |

### Sharing / metadata

| # | Idea | Tag | Rationale |
|---|---|---|---|
| 42 | **Open Graph + meta description** | additive | The report is shared as a link and previews as a bare URL. |
| 43 | **Favicon** | additive | Cheap identity for a pinned tab. |
| 44 | **schema.org `Event` JSON-LD** | additive | Makes the archive machine-readable for future tooling at near-zero cost. |

---

## 5. Index page and archive

| # | Idea | Tag | Rationale |
|---|---|---|---|
| 45 | **Richer index cards** | additive | `docs/index.html` is a bare `<ul>` of two links. Adding each week's Top-3 titles + event count makes the archive browsable. |
| 46 | **Cross-week search** | additive | Static JSON index + client-side search. Real value once there are 20+ weeks; only 2 published today. |
| 47 | **RSS/Atom feed** | additive | Turns the archive into something subscribable. |
| 48 | **Attendance retro view** | **blocked** | See below. |

**Anything historical is blocked on the picks log, which is currently a dead input.**

- **`csv_log.py` and `attendance_check.py` are built and tested but deliberately not
  run.** `scripts/runner.sh:10-16` defers them until the pipeline is proven end to end,
  and notes `data/event-picks-log.csv` "doesn't exist yet — it needs an init/seed
  decision first." `presentation.yml` only `git add docs/`. So **no v2 week has ever
  been logged**.
- The only file is the v1 snapshot at `docs/v1/Data/event-picks-log.csv` — 164 rows,
  2026-04-13 → 2026-07-06, and messier than it looks:
  - **`week_of` is not a usable week key.** Only three values are Monday-anchored; the
    `2026-06-08`…`2026-06-21` rows use a *per-day* `week_of`. It's ~3–4 real logged
    runs, not 17 weeks.
  - **`attended` is unusable as a rate**: blank 71, `false` 58, `true` **4**, and **29
    rows holding leaked tag values** (`cult-film`, `noise`, `diy`) — v1's LLM wrote a
    second tag into the `attended` column for the 06-15..06-21 weeks. Those rows also
    carry full category labels (`"Horror & Occult"`) where every other row uses the slug.
  - `rank` mixes `HM` and `hm`; `category` mixes slugs and full labels.
  - `attendance_check.py`'s own docstring notes HM rows can never be `true` (calendar
    only ever holds the 21 Top 3), so they always resolve `false` — the denominator is
    wrong by construction.
  - **`tags` is permanently blank in v2** by design — `_selections.json` carries no tag
    data and inventing tags would mean guessing.

Re-enabling the loop plus a seed/repair decision is a prerequisite for #15 and #48, and
is worth its own change rather than being smuggled into a report redesign.

---

## 6. Recommended first slice

Ordered by value-per-unit-risk, against the current baseline: **August-scale volume,
capped to 10 rendered cards per category per day.** All Tier A — renderable today from
`_selections.json`, no schema change, no new file loads, no JS:

1. **The 10-card cap itself, done right** (§2's subsection) — priority-sort (Top 3 →
   Honorable Mention → chronological) before slicing, not a naive `events[:10]`. This is
   the one item in this slice that fixes a concrete, already-confirmed bug (a real Top 3
   pick would be truncated away this week under a naive slice) rather than adding
   polish, and it has to land before or alongside the stats work below since both touch
   `build_categories()`.
2. **Stats section v1** (#1, #2) — the sorted bar/meter (true listed count vs Top 3,
   per category — not a waffle, see §2), plus the source-concentration bar. Reads the
   *pre-cap* full counts, which the cap change above doesn't remove from
   `_selections.json` — only from what gets rendered as cards. Add #3/#4/#5 (collection
   health, zero-yield sources, yield-vs-floor) if a second file load is acceptable.
3. **True counts in headers** (#21) — `🎵 Music & Concerts (10 of 51 shown)` — the
   minimum needed so the cap is legible rather than silently hiding events.
4. **Dark mode + mobile breakpoint** (#26, #27) — small, visible, overdue, and the
   report is genuinely not responsive today despite claiming to be.
5. **TOC + anchors** (#23, #22), **reconsider sticky nav** (#16) — 327 capped cards is
   still a real scroll; worth building rather than dropping now that real volume is the
   baseline again.
6. **Map links from `address`** (#31), **derived sources footer** (#32), **sold-out on
   Top 3** (#36) — free data already sitting unused, and a footer that currently
   misstates which sources contributed.

Then, as a second pass with more appetite: **the recurrence/All-Week restoration** (#38)
— the only item on the list that closes a documented spec gap rather than adding to spec.

Deliberately deferred: filters and search (#17–#19 — the cap already does most of that
job), remaining schema changes (#37, #39), a full per-category ranking beyond
Top 3/HM (flagged in §2 as a real but bounded token increase, not part of this slice),
and anything blocked on the picks log (#15, #48).

---

## 7. Resolved questions and loose ends

- **JS:** GitHub Pages does not constrain this — see constraint #5. It's a durability
  call, and the safe answer is progressive enhancement only. Still Greg's to make, but
  it no longer blocks the first slice, which needs no JS at all.
- **Density:** resolved as "August volume is the baseline; cap rendered cards to 10 per
  category per day" (superseding the earlier "June is representative" call). §3 re-scored
  against the capped-Aug shape, not against June or against the uncapped 486.
- **The cap's design is resolved:** priority-sort (Top 3 → HM → chronological) before
  slicing to 10, implemented entirely in `html_render.py`/`build_categories()`. No
  `_selections.json` schema change, no Selection Routine change, no token cost — see
  §2's subsection for the confirmed bug this avoids (a real Top 3 pick would be cut by a
  naive `events[:10]` this week).
- **Still open:** whether the stats section reads `_candidates.json`/`_manifest.json`
  (a second file load in `render_report()`) or stays inside `_selections.json`. That
  single decision separates "Greg's waffle, minus the gray tier" from "the full
  collection-health picture."

Also noted in passing: **`CLAUDE.md:9` is stale** — it says "no code exists yet," but
the full `scripts/` suite is built, tested, and wired into GitHub Actions. Worth fixing
whenever the file is next touched.

---

## 8. Verification (for whatever slice is chosen)

- `pytest tests/test_html_render.py` — expect the golden test to fail; regenerate
  `tests/golden/actual-2026-06-22.html` and **review the diff** before committing.
- `python scripts/html_render.py data/2026-08-03 /tmp/check-aug.html` — the **primary
  check now**: August is the representative shape. Specifically confirm Friday and
  Saturday Music (51 and 44 true listings) render exactly 10 cards each, that "The Body,
  with BIG|BRAVE, Carnivorous Bells" (Friday's Top 3 pick) is one of them, and that the
  header count reads the true total (e.g. "10 of 51 shown"), not the capped one.
- `python scripts/html_render.py data/2026-06-22 /tmp/check-jun.html` — the sparse case;
  confirm the cap and stats degrade gracefully when a category has fewer than 10 events
  (no "+0 more" text, no empty state weirdness).
- Open both at 375 px and 1440 px, in light and dark, and print-preview.
- `ruff` / `mypy` per `.github/workflows/lint.yml`.
- Note `html_render.py` also rewrites `docs/index.html` as a side effect — run against a
  scratch path first, or expect an index diff.
