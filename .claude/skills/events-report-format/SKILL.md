---
name: events-report-format
description: Output format specification for the weekly This Week in Philadelphia events report. Use this skill when writing or rendering the final report. Governs HTML structure, Top 3 card format, Spotify linking, category organization, and honorable mentions. Apply after event selection is complete.
---

# Report Format

## Output

The report is an HTML file. The output directory and full path are specified in the report generation task. Filename convention:

```
this-week-in-philadelphia-[mon-abbr][day]-[sun-abbr][day]-[year].html
```

Example: `this-week-in-philadelphia-jun08-jun14-2026.html`

---

## Page Structure

- Dark header bar (`background: #111`) spanning full page width; inner content `max-width: 800px; margin: 0 auto; padding: 1.4rem 1.5rem 1.5rem`
- Header content: small gold eyebrow `"Weekly Guide"` (uppercase, `color: #c9a84c`), then `<h1>` "This Week in <span style='color:#c9a84c'>Philadelphia</span>", then muted subtitle with date range and "Compiled Sunday"
- Page background `#f0ede8`; content wrapper `max-width: 800px; margin: 0 auto; padding: 1.75rem 1.5rem 3rem`
- Each day separated by `<hr>` hairline (`border-top: 1px solid #d8d4ce`)

---

## Colour Tokens and Dark Mode

Every colour in `templates/report.html.j2` is a custom property on `:root`, so
`@media (prefers-color-scheme: dark)` restates the palette and nothing else.
System preference only — no toggle, matching `templates/index.html.j2`.

Dark is **not** a mechanical inversion. In light, the Top 3 card is the darkest
thing on a pale page; inverting that would sink it into the background, so in
dark it becomes the most *elevated* surface instead — page `#1a1815` < event
card `#26231f` < Top 3 card `#2e2a25` — keeping "raised means important" true in
both themes. The gold accent (`--gold`) lightens to `#d7b75f` to hold up
against the darker ground.

Every foreground/background pair in the **dark** palette clears WCAG AA (4.5:1),
measured rather than eyeballed. The light palette does not and is otherwise
unchanged here; a contrast pass over it is its own slice. The one light value
this spec moved is `--feature-meta` (`.pick-time-cost`), which was `#666` on the
`#1c1c1c` card — 2.97:1, the only outright unreadable pair — and is now `#848484`
at 4.56:1, still dimmer than `--feature-why` so the card's hierarchy holds.

---

## Day Index

A zero-JS `<nav class="day-index">` directly below the header: one link per day,
`#<weekday>` (lowercased, e.g. `#saturday`), each followed by that day's event
count. Each `.day-header` carries the matching `id`.

The weekday is the anchor rather than the ISO date because a report covers
exactly one Mon–Sun span, so it's unique within the page and survives being
typed from memory. The counts are **true counts, before the display cap** — this
is the one place on the page that states real scale, which is why category
headers don't repeat it.

Deliberately not built: a sticky day bar or a back-to-top control. The page runs
roughly 11 cards a day across 7 days; both would cost more than they return at
that size.

---

## Responsive Behaviour

Every card in this spec is a desktop flex row with a fixed-width, right-aligned
meta column. Those columns need two guards, both in `templates/report.html.j2`:

**At every width** — the meta columns (`.pick-meta`, `.event-right`) are
`flex-shrink: 0`, so they size to their own content. Venue strings carry full
street addresses (130 characters is real, unshortened by design), which on
desktop starved the title column down to one letter per line. They are capped at
`max-width: 50%`, and `body` sets `overflow-wrap: break-word` (it inherits) so no
single long token can force the page wider than the viewport.

**Below `600px`** (`@media (max-width: 600px)`) — each card wraps its meta column
onto its own full-width line, left-aligned, and drops the `max-width` cap:

- `.top3-pick` / `.event-card` gain `flex-wrap: wrap`; `.pick-meta` /
  `.event-right` get `flex-basis: 100%`, `text-align: left`. `.pick-meta` is
  indented `1.85rem` (`.pick-num`'s `1.1rem` + the row's `0.75rem` gap) so it
  hangs under the title, not under the number.
- Venue takes its own line within the meta block; time and price sit beneath it
  on one line, separated by a `·` pseudo-element.
- The All Week table becomes stacked cards: `thead` hidden, each `tr` a white
  card, each `td` a block labelled from its `data-label` attribute. (This is the
  spec's one piece of required markup beyond the table itself — the `<td>`s must
  carry `data-label="Event|Venue|This week|Price"`.)
- Type and padding tighten: `h1` to `1.5rem`, header/content side padding to
  `1rem`, `.day-date` to `1.1rem`.

The gate is horizontal overflow, not appearance: at 320/375/390/414/768/1024 px,
`document.documentElement.scrollWidth` must not exceed `clientWidth`. Before this
section existed, a 320px viewport rendered a 755px-wide page.

---

## Day Header

```html
<div class="day-header">
  <span class="day-name">Monday</span>       <!-- 0.62rem, uppercase, #999 -->
  <span class="day-date">June 9</span>       <!-- 1.25rem, bold, #1c1c1c -->
  <div class="day-rule"></div>               <!-- flex:1, 1px, #d8d4ce -->
</div>
```

---

## Top 3 Picks Card

Card style: `background: #1c1c1c; border-radius: 7px; padding: 1rem 1.25rem`

- Gold label "⭐ Top 3 Picks" (`0.62rem` uppercase, `#c9a84c`)
- Each pick: `[num gold]` `[name bold white + why muted below]` `[venue right-aligned #bbb / time·cost #666]`
- Spotify links on act names where found (`color: #c9a84c`)

Keep descriptions punchy. Explain *why* — not just what the event is, but what makes it worth choosing over everything else that day. Where relevant, include venue neighborhood or SEPTA accessibility — especially for venues outside Center City.

---

## Honorable Mentions

Directly below the Top 3 card, add one italic line for events that nearly made the cut — typically due to time conflicts with a top pick, or because they're prominent enough to stand on their own:

```html
<p style="font-size: 0.77rem; color: #999; font-style: italic">
  Honorable mentions: [Event A] at [Venue] · [Event B] at [Venue]
</p>
```

2–3 events max. Only list events actually evaluated for Top 3. Omit entirely on days where nothing came close.

---

## Category Blocks

**Category label:** `0.62rem` uppercase `#999` with `::after` hairline rule extending right

**Event cards:** `background: #fff; border-radius: 5px; padding: 0.5rem 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.06); gap: 0.3rem`

Each card:
- Left: event name (`0.85rem` bold) + `note` field (`0.73rem #999`)
- Right-aligned: venue (`0.78rem` bold `#444`) · time · price (`0.7rem` — `color: #2d7a3a` if free, `#999` if paid)
- Spotify links on act names where found
- Events that appear in the Top 3 for that day: prefix the event name with ⭐ (no additional styling needed beyond the marker)

---

## Categories

Use these emoji headers, in this order. Omit categories with no events for that day.

| Emoji | Category | Covers |
|-------|----------|--------|
| 🎵 | Music & Concerts | All live music and DJ events |
| 🎬 | Film & Cinema | Screenings, film society events, Trakt.tv theatrical releases |
| 📚 | Literary | Author events, bookstore happenings, poetry, book clubs |
| 🤝 | Community & Politics | Activist events, fundraisers, solidarity events, civic programming |
| 🎨 | Arts & Workshops | Gallery openings, performance art, experimental arts, occult/horror culture |
| 💻 | Tech & Maker | Software meetups, hackerspaces, electronics workshops |
| 🌿 | Markets & Outdoors | Farmers markets, food pop-ups, restaurant events, tastings |
| 👻 | Horror & Occult | Horror screenings, paranormal events, gothic culture, dark/strange events |
| 🎪 | Festivals & Major Events | Multi-day or large-scale events |

Within each category, list events chronologically by start time.

**Trakt.tv film releases:** Add to 🎬 Film & Cinema on their release date. Set venue to "Theatrical release" if no venue is present.

**Online-only events:** Include in the appropriate category. Append `(Online)` after the venue field. Do not include in Top 3 unless genuinely exceptional.

---

## All Week / Recurring

Add a table at the bottom of the report for multi-day events spanning 3+ days.

---

## Week in Numbers

Between the All Week table and the sources footer — it's meta-information about
the week, so it follows the week's content. Zero JS; hover detail rides on
`title` attributes. `html_render.py`'s `build_stats()` is the implementation.

Four blocks, each in the form its data actually calls for:

1. **The funnel — a KPI row, not a chart.** `Collected · Candidates · Listed ·
   Top 3 picks`, each after the first carrying its drop from the previous
   (`−89% from candidates`). Values use proportional figures, not
   `tabular-nums` — they don't align in a column.
   **Collected comes from `_manifest.json`; when that's missing the tile is
   simply absent and the funnel starts at Candidates.** `data/2026-06-22`
   predates v2 and has no manifest, so this path is live, not theoretical.
   "Listed" must count All Week / Recurring events too — they're routed out of
   the day category blocks, so summing categories alone under-reports it
   against the page directly above.
2. **By category — sorted horizontal stacked bars.** Length ∝ the **true,
   pre-cap** listed count summed across all 7 days (`true_count`, never the
   capped display count), on one shared scale so magnitudes compare across
   rows. A leading gold segment ∝ Top 3 count, so Top 3 counts align at the
   baseline. A category that won no slot renders **at its true length with no
   gold** — that's the signal, not an empty row to hide.
3. **By source — sorted horizontal bars, single hue.** Contributors only,
   descending. One series, so no legend: the row label carries identity.
4. **Collection health — a sentence, not a chart.**

**The health line reports sources below their documented floor, never bare
zero-yield.** Five sources return `status: ok` with 0 events in a typical week
(`meetup-ai-philly`, `meetup-owasp`, `meetup-philly-film-club`,
`meetup-tech-in-motion`, `philly-shows`) and every one of them carries
`min_expected: 0` in `data/expected_yield.json` — they are documented as
legitimately quiet, not broken. A "5 sources silent this week" stat would cry
wolf every single week. `scripts/check_yield.py`'s `check_yield_floor()` owns
the rule, exemption included; `build_stats()` calls it rather than deriving a
second one.

### Chart colour

Two marks only: `--gold` for what won a Top 3 slot, `--stat-bar` for everything
else. That's an **emphasis** pair — one accent plus a de-emphasis neutral — not
a categorical palette, and it's validated as such. The checks that decide
whether two adjacent segments can be told apart pass in both themes (CVD
separation 19.0 light / 19.3 dark; normal-vision ΔE 20.2 / 20.4). `--stat-bar`
was re-stepped darker to get there: a paler grey sat at 14.0, under the 15
normal-vision floor.

The palette validator also reports a chroma-floor failure on `--stat-bar`
("reads gray") and a lightness-band failure on `--gold` in dark. Both are scope
mismatches, not defects: a de-emphasis neutral is *supposed* to read gray, and
`--gold` is the report's existing brand accent rather than a slot chosen for
this chart. `--gold`'s low contrast against the light paper (1.96:1) is why the
per-row count labels are **mandatory** — that's the relief the contrast warning
obligates, not decoration.

Mark specs: bars 9px (cap 24px), square at the baseline and 4px-rounded at the
data end, a **2px surface-coloured gap** between the gold and neutral segments
(a gap, never a border drawn around the mark), and a 6px `min-width` so a
single event still reads as a mark instead of a 1px sliver. Counts render
*outside* the bar end, where a short bar can't clip them.

---

## Sources Footer

Centered, `0.7rem`, derived from the week's own events — **not** a fixed list.
`html_render.py`'s `build_sources()` is the implementation.

- Every source in `SOURCES` renders every week, in that list's order. A source
  that contributed carries its event count; one that was watched but silent is
  dimmed (`--source-silent`) and carries no count. The footer used to be a
  hardcoded list, which meant it claimed credit for sources that sent nothing
  and stayed silent about ones that did.
- Counts come from each event's `source` field, normalized by
  `normalize_source_name()`. Three shapes matter, all of them real: an event
  can name more than one source separated by **either** `/` or `,`
  (`Do215 / WXPN`, `Do215, WXPN` — both credit both); Meetup arrives per-group
  (`Meetup: Code & Coffee`) and collapses onto the single `Meetup` entry; and
  `WXPN` is the publication `SOURCES` lists as `The Key by WXPN`.
- A source that contributed but has no `SOURCES` entry renders **unlinked,
  after the known list, never dropped**. This is the retired-source case
  (`Songkick`, `Free Library`, `Hive76`, `Philadelphia Citizen`,
  `Trakt.tv film releases`): they're absent from collection now but still
  present in published weeks, which get re-rendered.

If any sources failed during collection, append below the footer:
```html
<p style="text-align:center; font-size:0.7rem; color:#bbb">
  ⚠️ [source] unavailable this week — events from that source may be missing.
</p>
```

---

## Spotify Linking

For any music act in the Top 3 picks:
- Search for their Spotify artist page and embed the link inline in the act name
- If no confident match is found, omit the link rather than guessing
- For non-music Top 3 picks (readings, screenings, etc.), link to the event page or venue URL instead

## Weekly Playlist Link

When a playlist was built for the week, the header carries a link to it,
directly below the subtitle line:

```html
<div class="header-playlist"><a href="[playlist url]">♫ This week's picks on Spotify</a></div>
```

- `color: #c9a84c` (the same gold accent as inline Spotify links), `font-size: 0.75rem`, no underline until hover
- **Omit the whole element** when there's no playlist — `scripts/spotify_playlist.py` skips silently (no `_playlist.json`) when Spotify auth fails or no music act matched, and the report must render normally without it
- The playlist itself is public and named `YYYY-MM-DD: This Week in Philly` — date first so a title truncated in Spotify's sidebar still sorts and reads chronologically
- It holds 3 recent tracks (the matched act's latest album or single) for each matched Top 3 music act -- not an official "top tracks" list, which Spotify deprecated. Its contents therefore inherit the two limits above: honorable-mention acts are absent, and a multi-act bill contributes only the headliner

---

## Aggregation Notes

**Expected overlap by source tier:**
- **R5 + PhilaMOCA + Philly Ask A Punk** — significant overlap for punk/hardcore/DIY shows. R5 is authoritative (sold-out status, exact price). Deduplicate against Do215; prefer the R5 entry when merging.
- **Philly Ask A Punk** is the most complete DIY source and rarely overlaps with Do215 — treat as additive.

**General rules:**
- Prefer the source with the most complete information (venue, time, price) when merging duplicates
- R5 is authoritative for sold-out status — always note if a show is sold out even for non-Top-3 picks
- For R5 fundraiser shows, always include the beneficiary organization in the event description

---

## Verification Before Finalizing Top 3

- Search `[event name] Philadelphia [date] postponed` to catch cancellations
- Check venue's own calendar if anything seems uncertain
- Venue websites are more reliable than aggregators for postponement status
