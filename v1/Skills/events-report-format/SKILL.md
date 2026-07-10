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

## Sources Footer

Centered, `0.7rem #bbb`, each source name linked to its URL:

Do215 · Lightbox Film Center · cinéSPEAK · Philadelphia Film Society · PhilaMOCA · Phillygoth.net · Harriet's Bookshop · Iffy Books · Wooden Shoe Books · The Rotunda · R5 Productions · Free Library · Billy Penn · Philadelphia Citizen · Philly Ask A Punk · The Key by WXPN · Meetup · Hive76 · Luma · Songkick · Google Calendar

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

---

## Aggregation Notes

**Expected overlap by source tier:**
- **R5 + PhilaMOCA + Philly Ask A Punk** — significant overlap for punk/hardcore/DIY shows. R5 is authoritative (sold-out status, exact price). Deduplicate against Do215 and Songkick; prefer the R5 entry when merging.
- **Do215 + Songkick** — broad overlap for mid-size and larger shows. Do215 has better context; Songkick has wider coverage. Merge and prefer whichever has more detail.
- **Philly Ask A Punk** is the most complete DIY source and rarely overlaps with Songkick/Do215 — treat as additive.

**General rules:**
- Prefer the source with the most complete information (venue, time, price) when merging duplicates
- R5 is authoritative for sold-out status — always note if a show is sold out even for non-Top-3 picks
- For R5 fundraiser shows, always include the beneficiary organization in the event description

---

## Verification Before Finalizing Top 3

- Search `[event name] Philadelphia [date] postponed` to catch cancellations
- Check venue's own calendar if anything seems uncertain
- Venue websites are more reliable than aggregators for postponement status
