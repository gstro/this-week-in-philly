---
name: philadelphia-sources
description: Source collection instructions for the weekly This Week in Philadelphia events report. Use this skill when gathering events from web sources, Meetup groups, and Google Calendar for the weekly Philadelphia events report. Contains per-source URLs, known quirks, and extraction techniques. Trigger at the start of any Philadelphia weekly events collection run.
output_directory: data
---

# Philadelphia Events — Source Collection Instructions

This skill documents how to collect events from each source for the weekly This Week in Philadelphia report. Read this before beginning any collection run.

Sources are listed in execution order — cheapest and most reliable first, most expensive last. If a session runs short, what gets cut is the broad aggregators at the end, not the high-alignment specialist sources at the start.

---

## Date Range

Always collect for the full week: **the Monday immediately following today through the Sunday after that** (i.e., the upcoming 7-day window starting tomorrow). Compute the date range from today's date at runtime.

---

## Collection Discipline

These rules govern Claude's behavior during the collection phase. They apply to every source without exception. Their purpose is to keep conversation context lean and collection runs recoverable.

---

### Output Directory Structure

Write all collected events to a dated directory under the `output_directory` specified in this skill's frontmatter (`data`, repo-relative, by default):

```
{output_directory}/
  YYYY-MM-DD/              ← Monday of the target week
    [source-name].json     ← one file per source (see naming below)
    _manifest.json         ← written last; records completion status
```

**Source filename convention:** lowercase, hyphenated, no special characters.

| Source | Filename |
|--------|----------|
| Philly Ask A Punk | `philly-ask-a-punk.json` |
| Luma | `luma.json` |
| The Rotunda | `the-rotunda.json` |
| Iffy Books | `iffy-books.json` |
| Wooden Shoe Books | `wooden-shoe-books.json` |
| Trakt.tv film releases | `trakt-film-releases.json` |
| R5 Productions | `r5-productions.json` |
| Hive76 | `hive76.json` |
| Philadelphia Film Society | `philadelphia-film-society.json` |
| Harriet's Bookshop | `harriets-bookshop.json` |
| Free Library | `free-library.json` |
| PhilaMOCA | `philamoca.json` |
| cinéSPEAK | `cinespeak.json` |
| Lightbox Film Center | `lightbox-film-center.json` |
| Phillygoth.net | `phillygoth.json` |
| Philadelphia Citizen | `philadelphia-citizen.json` |
| WXPN | `wxpn.json` |
| Meetup: Philadelphia Horror | `meetup-horror.json` |
| Meetup: Code & Coffee | `meetup-code-coffee.json` |
| Meetup: AI Philly | `meetup-ai-philly.json` |
| Meetup: Tech in Motion | `meetup-tech-in-motion.json` |
| Meetup: DC 215 | `meetup-dc215.json` |
| Meetup: OWASP | `meetup-owasp.json` |
| Meetup: Philly Hardware | `meetup-philly-hardware.json` |
| Meetup: Philly Film Club | `meetup-philly-film-club.json` |
| Philly-Shows.com | `philly-shows.json` |
| Do215 | `do215.json` |
| Billy Penn | `billy-penn.json` |
| Songkick | `songkick.json` |

Create the dated directory before the first source run. Do not write `_manifest.json` until all sources have been attempted.

---

### Event Schema

Each source file contains one JSON object:

```json
{
  "source": "R5 Productions",
  "collected_at": "2026-06-08T19:14:00",
  "events": [
    {
      "title": "Saetia",
      "venue": "First Unitarian Church",
      "date": "2026-06-14",
      "time": "7:00 PM",
      "cost": "$15",
      "url": "https://r5productions.com/events/...",
      "description": "A Fundraiser for Juntos Philadelphia. Saetia reunite for a benefit show supporting immigrant rights organization Juntos."
    }
  ]
}
```

**Description field:** Write the full event description as provided by the source. Do not summarize, truncate, or editorialize. The description is used during report generation for interest matching and Top 3 blurb writing — not during collection. For Songkick specifically, write the first paragraph only; Songkick descriptions are long promotional copy with minimal additional signal after the first paragraph.

**Empty sources:** Write the file with an empty events array:
```json
{ "source": "Meetup: OWASP", "collected_at": "...", "events": [] }
```

**Failed sources:** Write the file with a status field:
```json
{ "source": "Songkick", "status": "failed", "reason": "pagination timeout", "collected_at": "..." }
```

---

### Manifest File

Write `_manifest.json` after all sources have been attempted:

```json
{
  "week": "2026-06-08",
  "run_started": "2026-06-08T19:03:00",
  "run_completed": "2026-06-08T20:14:00",
  "sources": {
    "philly-ask-a-punk": { "status": "ok", "events": 9 },
    "luma": { "status": "ok", "events": 14 },
    "meetup-owasp": { "status": "ok", "events": 0 },
    "songkick": { "status": "failed", "reason": "pagination timeout" }
  }
}
```

Status values: `ok` (file written, zero or more events), `failed` (fetch error, file written with status field).

---

### Resume Behavior

At the start of every collection run, before fetching any source:

1. Check whether `{output_directory}/YYYY-MM-DD/` exists
2. If it does, read `_manifest.json` if present
3. Skip any source whose filename already exists in the directory with `status: ok`
4. Re-attempt any source with `status: failed`
5. Fetch all sources not present in the directory

**If the manifest does not exist but source files do** (interrupted run before manifest was written): treat any existing source file as completed and skip it. Do not overwrite existing files.

Emit at the start of a resumed run:
```
Resuming collection for 2026-06-08.
Completed: 18 sources. Remaining: do215, billy-penn, songkick.
```

---

### Confirmation Turn Format

After writing each source file, emit exactly this and nothing more:

```
[Source name]: [N] events written. Proceeding.
```

Examples:
```
Philly Ask A Punk: 9 events written. Proceeding.
Meetup: OWASP: 0 events written. Proceeding.
Songkick: FAILED — pagination timeout. Proceeding.
```

Zero events is a valid result. Failed sources use the FAILED format. In both cases: write the file, emit the confirmation, move to the next source immediately.

---

### Prohibited Behaviors

During collection, Claude must not:

- **Narrate collected content** — do not describe, list, or quote events in the conversation
- **Summarize sources** — do not produce "here's what I found at The Rotunda" responses
- **Reason across sources mid-run** — no cross-source comparison, ranking, or interest scoring until report generation
- **Retry failed sources** — one attempt per source per run; use resume behavior for retries
- **Exceed the confirmation turn format** — no additional commentary in confirmation turns
- **Read source files back into context** — write-only during collection; files are read during report generation only
- **Write custom collection/aggregation scripts** — call each source's documented Method directly (Bash → `fetch_page_text.py`, the relevant MCP tool, or WebSearch), one source at a time, exactly as this skill specifies. Do not build a Python script that fetches, parses, or batches multiple sources itself — that reimplements what this skill already documents and is slower to debug when a single source breaks

---

### End of Collection

When all sources have been attempted and `_manifest.json` has been written, emit:

```
Collection complete. [N]/[T] sources ok, [F] failed ([source names]).
[E] total events written to {output_directory}/YYYY-MM-DD/.
```

Example:
```
Collection complete. 27/28 sources ok, 1 failed (songkick).
312 total events written to data/2026-06-08/.
```

Then stop. Do not begin report generation in the same turn.
Report generation is a separate phase that reads from the output directory.

---

## Sources

### Tier 1 — fetch_raw.py / MCP (no browser required)

Run these first. No browser session overhead; structured or semi-structured responses; write-and-forget is straightforward.

---

### 1. Philly Ask A Punk
**URL:** `https://philly.askapunk.net/api/events`
**Method:** Bash → `python scripts/fetch_raw.py https://philly.askapunk.net/api/events` — returns JSON directly, no browser required. Use `fetch_raw.py`, not the `WebFetch` tool: WebFetch runs an AI summarization pass that can silently truncate or paraphrase a large raw JSON array; `fetch_raw.py` is a plain HTTP GET with no model in the loop, so the full events array comes back exactly as the API returned it.
**Notes:** Best punk/DIY source. Catches shows that don't appear on larger aggregators — basement shows, benefit gigs, touring DIY bands. Run by the Gancio federated events platform.

**JSON response shape:**
```json
{
  "id": 474,
  "title": "Demonstrate Record Release",
  "slug": "demonstrate-record-release",
  "start_datetime": 1781305200,
  "end_datetime": 1781319600,
  "multidate": true,
  "tags": ["hardcore", "punk"],
  "place": { "name": "The First Unitarian Church", "address": "2125 Chestnut Street" },
  "online_locations": ["https://r5productions.com/..."]
}
```

**Filtering for the target week:** `start_datetime` is a Unix timestamp in UTC. See iCal Parsing Reference for the Python filtering snippet. For multi-day events, check for `"multidate": true` — include if `start_datetime` is before the window ends AND `end_datetime` is after the window starts.

**Also check:** `/feed/ics` returns valid iCal; `/feed/rss` includes full HTML descriptions with embedded Bandcamp/Spotify links — useful for finding artist links without a separate search.

**✅ Confirmed Jun 2026**

---

### 2. Luma
**URL:** `https://api.luma.com/ics/get?entity=discover&id=discplace-VGLZZfVwOKRD1Yd`
**Method:** Bash → `python scripts/fetch_raw.py <url>` — returns iCal directly, no browser required (see note on Tier 1's heading: use `fetch_raw.py`, not `WebFetch`, so the feed isn't summarized)
**Notes:** Increasingly dominant platform for tech, AI, and creative communities. Particularly useful for AI/vibe coding meetups, biotech/startup community events, and indie creative workshops. Philadelphia *discover* feed — featured/promoted events only, roughly 15–20 events per fetch spanning ~4 weeks. Low-noise.

**Parsing:** See iCal Parsing Reference. DTSTART is UTC (Z suffix) — apply EDT/EST offset. Each VEVENT includes SUMMARY, DTSTART, DESCRIPTION (full Luma URL + address + description), LOCATION, and ORGANIZER.

**✅ Confirmed Jun 2026** (refreshes every 12 hours per `X-PUBLISHED-TTL`)

---

### 3. The Rotunda
**URL:** `https://www.therotunda.org/events?date=YYYY-MM-DD` (any date in the target month)
**Example:** `https://www.therotunda.org/events?date=2026-06-01`
**Method:** Bash → `python scripts/fetch_raw.py <url>` — returns full event listing, no browser required
**Address:** 4014 Walnut St, Philadelphia, PA 19104 (West Philly)
**Notes:** Community arts space. 300+ events/year — free film screenings, experimental music, spoken word, community workshops. Alcohol-free, all-ages.

**Recurring series worth knowing:**
- **Bright Bulb Screenings** — free international/arthouse film series
- **Bowerbird Presents** — experimental/electronic music, high-prestige bookings
- **Event Horizon** — ambient/experimental music, Fridays
- **Fire Museum Presents** — avant-garde and world music

**Parsing:** Page renders as a monthly calendar grid. Filter by date — each cell contains the day number followed by event title, time, and description. If the target week spans two months, fetch both month URLs.

**Recurring events to deprioritize for Top 3:** Weekly improvised music jam (Wednesdays), Vogue Practice Session (Tuesdays).

**✅ Confirmed Jun 2026**

---

### 4. Iffy Books
**Calendar ID:** `uim84nkq226inhhqa44v98foigjak9us@import.calendar.google.com`
**Method:** `gcal_list_events` via Google Calendar MCP connector (see Google Calendar Sources section)
**Address:** 404 S 20th St, Philadelphia, PA 19146
**Notes:** DIY electronics workshops, speculative fiction reading groups, and leftist/community programming — strong overlap with Greg's interests (DIY electronics + literature + politics). Speculative Futures Reading Group meets last Wednesday of every month.

⚠️ **Not yet confirmed via MCP — test before relying on.**
**Fallback:** `python scripts/fetch_page_text.py https://iffybooks.net/` (read past the top item to get the full week; ✅ Confirmed Jul 2026 with `fetch_page_text.py`)

---

### 5. Wooden Shoe Books
**Calendar ID:** `t8qmive63n27mdj7gt03ntc2u8@group.calendar.google.com`
**Method:** `gcal_list_events` via Google Calendar MCP connector (see Google Calendar Sources section)
**Address:** 704 South St, Philadelphia, PA 19147
**Notes:** Philadelphia's anarchist radical bookstore. High-alignment source for leftist politics + literature overlap. Consistent calendar of readings, film screenings, and community events.

⚠️ **Not yet confirmed via MCP — test before relying on.**

---

### Tier 2 — Simple sources, low verbosity

Single-purpose venues with focused, low-prose event listings. Use each source's documented Method exactly — several of these are `fetch_raw.py` (server-rendered, no browser needed), not `fetch_page_text.py`.

---

### 6. R5 Productions
**URL:** `https://r5productions.com/events/`
**Method:** Bash → `python scripts/fetch_raw.py https://r5productions.com/events/` — the event list is fully server-rendered; a browser isn't needed (confirmed Jul 2026: every known venue in a real capture was present in the raw HTML).
**Notes:** Philadelphia's dominant mid-size indie promoter. Books First Unitarian Church, PhilaMOCA, Underground Arts, TLA, Johnny Brenda's, Ruba Club, Ukie Club, Cousin Danny's, Warehouse on Watts, Penn Museum, Philadelphia Ethical Society, Asian Arts Initiative, and Dell Music Center. Authoritative on sold-out status and exact pricing.

**Raw HTML structure (WordPress "RHP" events plugin):** ignore a long `<li class="optionFilter">` venue-filter dropdown near the top of the page — that's UI chrome, not events. Each real event is one block matching this shape (confirmed Jul 2026):
```html
<div id="eventDate" class="... eventMonth ...">Wed, Jul 22</div>
...
<div class="... eventTagLine ...">WXPN 88.5 Welcomes | Make The World Better Concert Weekend</div>
<a id="eventTitle" ...><h2 class="... rhp-event__title--list ...">PAVEMENTS (2024)</h2></a>
...
<span class="rhp-event__time-text--list">Doors: 7 pm | Show: 7:30 pm</span>
...
<span class="rhp-event__cost-text--list">$15.39</span>
...
<a class="venueLink" ... title="PhilaMOCA">PhilaMOCA</a>
```
Map: `.eventMonth` → date, `.eventTagLine` (if present) + the `h2` → title (tagline is often the tour/series name, keep both), `.rhp-event__time-text--list` → time, `.rhp-event__cost-text--list` → cost, `.venueLink` text → venue.

**Note on fundraiser shows:** R5 sometimes lists the beneficiary organization in the event subtitle (e.g. "A Fundraiser for Juntos Philadelphia"). Always capture this in the description field — it's high-value context for Greg's interests.

**✅ Confirmed Jul 2026 with `fetch_raw.py`**

---

### 7. Hive76
**URL:** `https://www.hive76.org/classes/`
**Method:** Bash → `python scripts/fetch_page_text.py https://www.hive76.org/classes/`
**Address:** Philadelphia hackerspace
**Notes:** Weekly open nights, member projects, electronics focus. Strong overlap with Greg's DIY electronics interest.

⚠️ **Use `/classes/` not `/events/`** — `/events/` redirects to a legacy wiki article. The actual calendar is at `/classes/` (confirmed Jun 2026). Open Houses run every Sunday 2:30–5pm (free, recurring).

**✅ Confirmed Jul 2026 with `fetch_page_text.py`**

---

### 8. Philadelphia Film Society
**URL:** PFS's 3 venues on Fandango (not filmadelphia.org — see below):
- `https://www.fandango.com/pfs-film-society-center-aaxow/theater-page` (1412 Chestnut St)
- `https://www.fandango.com/pfs-bourse-theater-aadjc/theater-page` (400 Ranstead St)
- `https://www.fandango.com/pfs-east-theater-aandq/theater-page` (125 S. 2nd St)

**Method:** Bash → `python scripts/fetch_page_text.py <url>` on each of the 3 venue pages above (default/"today" view — no `?date=` param needed). Real showtimes with title, rating, runtime, and exact times per screen.

**Why not filmadelphia.org directly:** 🚨 `fetch_page_text.py` is hard-blocked domain-wide on filmadelphia.org — confirmed Jul 2026: returns "Access Denied... request appears similar to malicious requests sent by robots" on every path tried (showtimes page, `/wp-json/`, RSS/iCal guesses), even with a realistic user-agent — a WAF doing client-fingerprint-level blocking, not just a UA check. Don't spend time trying to defeat it further. Fandango's theater pages for the same 3 venues are not behind this WAF and return the same underlying showtime data (PFS sells tickets through Fandango) — use those instead. Confirmed working Jul 2026, including curated/repertory titles (e.g. `L'Avventura (1960)`), with exact per-film times — more reliable than the old v1 method, which needed a manual Chrome-assisted resume and still couldn't confirm exact times (CAPTCHA-blocked calendar view).

**One fetch per venue is enough:** unlike Do215 (distinct one-off events per day), cinema programming runs in multi-day blocks — a single "today" snapshot per venue typically covers most of the target week's actual titles. Only add `?date=YYYY-MM-DD` fetches for specific days if session time allows and the week spans a Friday (when programming usually rotates).

**Descriptions:** the Fandango theater pages above give title/rating/runtime/showtimes only, no synopsis — needed anyway for the report's "why" blurb. Confirmed Jul 2026: a plain WebSearch per **distinct film title** (dedupe across the 3 venues and across the week — PFS often runs the same title at multiple venues/days) reliably returns a synopsis directly in the search result (e.g. searching `"The Odyssey" 2026 movie overview synopsis` returned "Odysseus, king of Ithaca, embarks on a perilous journey..." directly, no extra fetch needed). Don't try to construct a Fandango `/movie-overview` URL yourself — the slug includes an internal ID (e.g. `the-odyssey-2026-241283`) that isn't derivable from the title, and the link only exists in the rendered DOM (JS-populated), not in `fetch_page_text.py`'s plain-text output. One WebSearch per distinct title is simpler and works reliably.

**🚨 FALLBACK — WebSearch:** If all 3 Fandango pages fail (e.g. Fandango itself changes/blocks): `query: "Philadelphia Film Society" OR "PFS" showtimes [Month] [Year]`, then a second variant `query: site:filmadelphia.org showtimes [week dates]` if the first returns nothing useful. Treat WebSearch results as lower-confidence (may reflect cached/indexed pages, not live listings) — note this in the description field.

**✅ Confirmed Jul 2026 with `fetch_page_text.py` via Fandango**

---

### 9. Harriet's Bookshop
**URL:** `https://www.eventbrite.com/o/harrietts-bookshop-52538975313`
**Fallback:** `https://do215.com/venues/harriet-s-bookshop`
**Address:** 258 E Girard Ave, Philadelphia, PA 19125
**Method:** Bash → `python scripts/fetch_page_text.py https://www.eventbrite.com/o/harrietts-bookshop-52538975313` on the Eventbrite org page
**Notes:** Celebrates women authors, artists, and activists. Hosts Whiskey Fridays, major launch parties, and community events. Check for readings, signings, and workshops.

⚠️ **harrietsbookshop.com is unreliable** — the main site and `/pages/events` both return error pages consistently (confirmed Jun 2026). Use the Eventbrite org page as primary. The Do215 venue page is a useful secondary that catches events posted there but not Eventbrite.

**✅ Confirmed Jul 2026 with `fetch_page_text.py`**

---

### 10. Free Library of Philadelphia
**URL:** `https://libwww.freelibrary.org/programs/authorevents/`
**Method:** Bash → `python scripts/fetch_page_text.py https://libwww.freelibrary.org/programs/authorevents/`
**Notes:** Extensive free literary programming, author talks, and community events across branches. Good source for high-profile author readings. Free admission.

⚠️ **Cloudflare bot-check blocks the default headless UA** — confirmed Jul 2026, `fetch_page_text.py`'s default user-agent already handles this (see the script's `_USER_AGENT`), no action needed, but if this source ever fails again this is the first thing to check.

**✅ Confirmed Jul 2026 with `fetch_page_text.py`**

---

### Tier 3 — moderate verbosity

Venues and publications with editorial voice or mixed content. More prose per event but still manageable. Use each source's documented Method exactly — several of these are `fetch_raw.py` (server-rendered, no browser needed), not `fetch_page_text.py`.

---

### 11. PhilaMOCA
**URL:** `https://www.philamoca.org/`
**Address:** 531 N 12th St, Philadelphia, PA 19123
**Method:** Bash → `python scripts/fetch_raw.py https://www.philamoca.org/` — the event list is fully server-rendered; a browser isn't needed (confirmed Jul 2026: every known event's venue was present in the raw HTML).
**Notes:** Philadelphia Mausoleum of Contemporary Art. The central hub for underground, horror, and weird culture in Philly. Check weekly — multiple recurring series run here:
- **Blood Sick Underground Cinema** — monthly horror screenings, 2nd Mondays
- **Psychotronic Film Society** — cult/horror screenings, twice monthly
- **Exhumed Films** — 35mm horror and exploitation events

**Secondary horror/occult sources** — check these after PhilaMOCA:
- **Phillygoth.net** (`https://phillygoth.net/`) — community-maintained dark/goth/occult calendar. Events that don't appear anywhere else.
- **Pennhurst Asylum** — ⛔ **skip in weekly runs**. No event calendar; on-demand ticket purchases only. 35 miles from Philly (~35mi). Check in **October** (haunted house season) and **around Paracon weekend in May** only.

**Raw HTML structure:** each event is one `<a class="event ...">` block (confirmed Jul 2026):
```html
<span class="event__title">Philadelphia Psychotronic Film Society</span>
<p class="event__description">Warning: Psychotronic films may contain extreme subject matter...</p>
<span class="event__detail-label">Tickets</span><span class="event__detail-value">$5 At Door</span>
<span class="event__detail-label">Doors</span><time class="event__details-value" datetime="19:00">7:00</time>
<span class="event__detail-label">Show</span><time class="event__details-value" datetime="19:30">7:30</time>
<time class="event__date" datetime="2026-08-03">...</time>
```
Map: `.event__title` → title, `.event__description` → description, `.event__detail--tickets .event__detail-value` → cost, `.event__detail--time time` → doors/show times, `.event__date` `datetime` attribute → date (ISO, use directly).

**✅ Confirmed Jul 2026 with `fetch_raw.py`**

---

### 12. cinéSPEAK
**URL:** `https://cinespeak.org/cinema/`
**Method:** Bash → `python scripts/fetch_raw.py https://cinespeak.org/cinema/` (primary — this page's listing is server-rendered as normal WordPress post content, no custom event markup to key off, just read the visible text between the markup). **Fallback:** if the raw response contains any of these phrases — `checking your browser`, `just a moment`, `please wait while we verify`, `performing security verification` — it's the intermittent WordPress.com/Jetpack bot-challenge interstitial (see below), not real content: re-fetch with `python scripts/fetch_page_text.py https://cinespeak.org/cinema/` instead, which already self-resolves this challenge by waiting it out in a real browser.
**Notes:** Arthouse film collective with politically engaged programming. Check for Third Thursdays (activist/documentary series) and other screenings. Events often free or PWYW.

⚠️ **Use `/cinema/` not the homepage** — `cinespeak.org` shows journal posts and mission copy with no event listings. `/events/` and `/screenings/` both 404 (confirmed Jun 2026).

⚠️ **Intermittent bot-challenge interstitial** — cinespeak.org sometimes (not always) shows a WordPress.com "Checking your browser..." page instead of real content, confirmed Jul 2026. A plain HTTP fetch (`fetch_raw.py`) has no way to wait it out the way a browser can — if you see the challenge markers above, use `fetch_page_text.py` for this one fetch instead.

**✅ Confirmed Jul 2026 with `fetch_raw.py`** (real content — matched known titles exactly in testing)

---

### 13. Lightbox Film Center
**URL:** `https://www.lightboxfilmcenter.org/`
**Address:** 1901 S 9th St (Bok Building), Philadelphia, PA 19148
**Method:** Bash → `python scripts/fetch_page_text.py https://www.lightboxfilmcenter.org/`
**Notes:** Philadelphia's premier repertory, experimental, documentary, and international cinema. Check weekly programming, series events, and special screenings. Free and low-cost screenings are common.

**✅ Confirmed Jul 2026 with `fetch_page_text.py`**

---

### 14. Phillygoth.net
**URL:** `https://phillygoth.net/`
**Method:** Bash → `python scripts/fetch_raw.py https://phillygoth.net/` — the event list is fully server-rendered; a browser isn't needed (confirmed Jul 2026: both known events' venues were present in the raw HTML).
**Notes:** Community-maintained dark/goth/occult calendar. Events that don't appear on any other source. Browse the events section. Listed under PhilaMOCA (§11) as a secondary horror/occult source — check both together.

**Raw HTML structure (WordPress "Events Manager" plugin):** each event is one `<div class="em-event em-item">` block (confirmed Jul 2026):
```html
<div class="em-event em-item" data-href="https://phillygoth.net/events/...">
  <h3 class="em-item-title"><a href="...">Stabbing Westward, Priest, &amp; Acumen Nation</a></h3>
  <div class="em-event-date em-event-meta-datetime"> July 21, 2026</div>
  <div class="em-event-location"><a href="...">Phantom Power, 121 W. Fredrick St. (Millersville, PA)</a></div>
  <div class="em-item-actions input"><p>All ages, 6pm doors, $35 adv / $40 DOS</p> Featuring: ... Links: <a href="...">Facebook event</a></div>
</div>
```
Map: `.em-item-title` → title, `.em-event-date` → date, `.em-event-location` → venue, `.em-item-actions` → time/cost/description.

⚠️ **Extract every `em-event` block in the target week, not just the first couple** — a past run under-collected here (2 events written when 7+ were actually in the window) by stopping early rather than scanning the full listing. Count the `em-event` blocks whose date falls in the target week before writing the file.

**✅ Confirmed Jul 2026 with `fetch_raw.py`**

---

### 15. The Philadelphia Citizen — Good Citizen Calendar
**URL:** `https://thephiladelphiacitizen.org/good-citizen-calendar/`
**Method:** Bash → `python scripts/fetch_raw.py https://thephiladelphiacitizen.org/good-citizen-calendar/` — this is a long-form blog post covering Jan-Dec, fully server-rendered (confirmed Jul 2026: a known event's exact text was found verbatim in the raw HTML).
**Notes:** Curated picks with editorial voice. Good for community, civic, and arts events with a progressive angle. Structure is prose under month headings (`JULY 2026`, `AUGUST 2026`, ...), not a card/list format — each item is a bolded date range or day (e.g. "July 24-25:") followed by a paragraph description.

⚠️ **Scan the full target week, not just the first match** — this page covers 6 months in one long scroll; a past run stopped after the first in-window item and missed a second one later in the same month's section (a concert listed under a different heading than the first match). Read through the entire month section(s) covering the target week before writing the file.

**✅ Confirmed Jul 2026 with `fetch_raw.py`**

---

### 16. The Key by WXPN
**URL:** `https://xpn.org/concert-and-events/`
**Secondary:** `https://xpn.org/feature/concert-previews/`
**Method:** Bash → `python scripts/fetch_page_text.py https://xpn.org/concert-and-events/`
**Notes:** WXPN (University of Pennsylvania) is one of the best indie/alternative/punk editorial outlets in the country. Good for discovering acts and finding Spotify links. The concert-previews archive has editorial roundup posts that are better for picks quality than the raw listing.

⚠️ **thekey.xpn.org has a certificate error** (confirmed Jun 2026) — do not use that subdomain. Use `xpn.org` directly. If `/concert-and-events/` output is sparse, try: `site:xpn.org "concert previews" philadelphia [month] [year]`

**✅ Confirmed Jul 2026 with `fetch_page_text.py`**

---

### Tier 4 — Meetup Groups (iCal via fetch_raw.py)

All Meetup groups now use the iCal method — no browser sessions required. Empty calendars are zero-cost to check.

---

### 17. Meetup Groups
**Method:** Bash → `python scripts/fetch_raw.py https://www.meetup.com/[group-slug]/events/ical/` (not `WebFetch` — see the note on Tier 1's heading)
**Parsing:** See iCal Parsing Reference. DTSTART uses `TZID=America/New_York` — no UTC offset conversion needed, parse date string directly.
**Filter:** LOCATION must contain a Philadelphia address. Flag empty or URL-only LOCATION as online-only — include for software/tech interest but note in report.

**If a group returns no VEVENTs:** write an empty events array and proceed immediately. Do not retry or navigate to the group page.

**✅ Confirmed Jun 2026** (all 8 groups tested)

| Group | Slug | Interest | Status |
|-------|------|----------|--------|
| Philadelphia Horror Meetup | `philadelphia-horror-meetup-group` | Horror | ✅ Active |
| Code & Coffee Philly | `code-coffee-philly` | Software | ✅ Active |
| AI Philly | `ai-philly` | AI/Software | ✅ Active |
| Tech in Motion: Philadelphia | `techinmotionphilly` | Tech | ✅ Active |
| DC 215 | `dc_215` | Hacker/Security | ✅ Active |
| OWASP Philadelphia | `owasp-philadelphia-chapter` | Security | Empty Jun 2026 — keep |
| Philly Hardware | `philly-hardware` | Hardware | Empty Jun 2026 — keep |
| Philly Film Club | `philly-film-club` | Film | Empty Jun 2026 — keep |

---

### Tier 5 — High verbosity / pagination required

These run last. If the session runs short, cut here — these are the broadest aggregators, and the high-alignment specialist sources (Tiers 1–3) will already be complete.

---

### 18. Philly-Shows.com
**URL:** `https://www.philly-shows.com/`
**Method:** Bash → `python scripts/fetch_raw.py https://www.philly-shows.com/` — the show list is fully server-rendered; a browser isn't needed (confirmed Jul 2026: real show data found directly in the raw HTML).
**Notes:** Dedicated Philadelphia hardcore and punk show tracker. Manually maintained. Sparse by design (confirmed Jun 2026 — ~2 shows/week vs. 9+ on Philly Ask A Punk for the same period). Lists prominent/R5-adjacent shows only, not the full DIY calendar. Quick pass only — treat as a supplementary spot-check after Philly Ask A Punk, not a primary source.

**Raw HTML structure (Webflow CMS list):** each show is one `<div class="showblock">` (confirmed Jul 2026):
```html
<p class="showdatevenue">July 17, 2026 7:00 PM</p>
<p class="showdatevenue">Bonks Bar -3467 Richmond Street, Phila Pa 19134</p>
<h3>Liberty &amp; Justice, XL Bully, The Uprise, Impact Driver, Off The Top, Rage &amp; Ruin, Vulture Raid</h3>
<p class="showdescription">Liberty &amp; Justice , XL Bully, ...</p>
<p class="showdescription showprice">$20</p>
```
Map: first `.showdatevenue` → date/time, second `.showdatevenue` → venue/address, `h3` → title (full lineup), `.showprice` → cost.

**✅ Confirmed Jul 2026 with `fetch_raw.py`**

---

### 19. Do215
**URL pattern:** `https://do215.com/events/YYYY/M/D` (no zero-padding on month or day)
**Method:** Bash → `python scripts/fetch_page_text.py https://do215.com/events/YYYY/M/D` on day-specific URLs
**Notes:** Sister site to Do512 — same platform, same React rendering, same URL structure.

**✅ Confirmed Jul 2026 with `fetch_page_text.py`:** Navigate to each day's URL directly (e.g. `do215.com/events/2026/7/22`) and it returns the full, rich event listing (venue, time, price, title) — no browser session, no URL-provenance workaround needed. Navigate Mon–Sun separately (7 calls). Filter out recurring "EVERY [DAY]" events.

This resolves the old `web_fetch`-specific problem: `web_fetch` requires a URL to have appeared in a prior message/search result before it can be retrieved (provenance), and Do215 day URLs aren't linked from the homepage, so the v1 skill previously needed a WebSearch-first workaround to satisfy that. `fetch_page_text.py` (playwright, not `web_fetch`) has no such restriction — navigate directly, no workaround required.

**🚨 FALLBACK — WebSearch:** If `fetch_page_text.py` fails for a specific day:
```
query: "site:do215.com/events/YYYY/M/D" OR "do215.com philadelphia events [Day Month Date 2026]"
```

<details>
<summary>Non-day-specific pages (homepage / <code>/events/</code>) — rarely needed</summary>

The standard day-URL flow above returns everything needed for a normal collection run. If you ever need the Do215 homepage or `/events/` instead (React-rendered, not confirmed against `fetch_page_text.py`), the old Chrome-console JS-extraction approach doesn't apply here (no Chrome), but the same idea works via playwright's `page.evaluate()` if this is ever actually needed -- not written out since the day-URL flow above should always be sufficient.
</details>

---

### 20. Billy Penn
**URL:** `https://billypenn.com` (search for current week's events calendar post)
**Method:** WebSearch — `site:billypenn.com events calendar [month] [year]`
**Notes:** Local nonprofit journalism with strong arts and events coverage. Publishes a weekly events calendar post. Treat similarly to editorial staff picks — good for curated voice on what's worth attending.

⚠️ **Post not live until Sunday morning** — won't exist on Friday runs. If not found via WebSearch, write an empty events array and proceed.

---

### 21. Songkick
**URL:** `https://www.songkick.com/metro-areas/5202-us-philadelphia/[month-YYYY]`
**Example:** `https://www.songkick.com/metro-areas/5202-us-philadelphia/june-2026`
**Method:** **Page 1: Bash → `python scripts/fetch_raw.py https://www.songkick.com/metro-areas/5202-us-philadelphia/[month-YYYY]`** (raw HTML — page 1's event data is fully server-rendered, no JS/browser needed). **Pages 2+ only (if the target week isn't covered by page 1's date range): Bash → `python scripts/fetch_page_text.py <url>?page=N`** (browser required — see note below).
**Notes:** Broadest music aggregator — 1,252+ events for June 2026 alone. Good for catching shows not on R5, Do215, or Philly Ask A Punk (smaller indie acts on Johnny Brenda's, Ortlieb's, MilkBoy, etc.).

⚠️ **Platform stability risk:** Songkick was acquired by Suno (generative AI) in November 2025. Revalidate this source at each quarterly check.

**Why page 1 uses `fetch_raw.py` but pages 2+ need `fetch_page_text.py`:** confirmed Jul 2026 — page 1's HTML has the full event listing server-rendered (`class="event-listings-element"` blocks with artist name, venue, and `<time datetime="...">`), so a plain HTTP GET returns everything a browser would. But `?page=2` (and beyond) returns `406 Not Acceptable` to a plain `requests`/curl-style client regardless of headers, cookies, or Referer — a CDN-level rule (Fastly) that appears to require a real browser's TLS/client fingerprint specifically on paginated requests. `fetch_page_text.py` still works for these (confirmed — Chromium's actual TLS fingerprint satisfies it). Parsing raw HTML instead of `fetch_page_text.py`'s clean extracted text means picking event title/venue/date out of markup directly — see the `.event-listings-element` structure above.

**Only fetch page 2+ when actually needed** — this keeps `fetch_page_text.py` usage here rare instead of mandatory. Page 1's plain HTTP fetch is ~0.2s; each `fetch_page_text.py` page-2+ fetch can take 30-70+ seconds even though the eventual content is correct, because Songkick's rendered page triggers a large real-time-ad-bidding request storm (confirmed Jul 2026: 200+ distinct third-party ad/tracking domains firing continuously) that `fetch_page_text.py`'s route-interception proxy workaround (docs/COLLECTION_PROXY_ISSUE.md) has to individually round-trip through `requests` rather than Chromium's native concurrent networking — this is what caused this source to time out entirely in a recent run. Needing page 2+ only when the target week falls later in the month (see pagination note below) keeps this cost occasional rather than guaranteed every run.

**Two issues to manage:**

1. **Pagination, capped at 4 pages** — paginates at ~10 events per page. Page 1 (via `fetch_raw.py`) typically covers the first ~3-4 days of the month. For week 2 of the month (Jun 8–14), append `?page=2` for Jun 11–14 (via `fetch_page_text.py`). For weeks 3–4, go to page 3+. **Stop at page 4 regardless of whether the target week is fully covered.** Per V2_IMPLEMENTATION_PLAN.md's Q4 analysis of the real picks log: only 2 of 84 logged Philadelphia Top 3 picks (2.4%) ever came from Songkick, and the specialist sources (Iffy Books, Do215, PhilaMOCA, Ask A Punk, R5) dominate picks — the cap costs essentially nothing.

2. **Geographic scope** — includes wider Philadelphia metro (Allentown, Camden NJ, Atlantic City, Wilkes-Barre). Filter to Philadelphia proper and inner suburbs (King of Prussia, Upper Darby, Ardmore). Discard events at Borgata Atlantic City, Bethlehem PA, etc. unless the act is genuinely unmissable.

**URL construction:** Month name is lowercase, hyphenated: `june-2026`, `july-2026`. If the upcoming week spans two months, fetch both month pages.

**Description:** First paragraph only — Songkick descriptions are long promotional copy with minimal additional signal after the first paragraph.

---

## Google Calendar Sources (via gcal_list_events MCP)

All Google Calendar sources use the same method: `gcal_list_events` with the calendar ID below and these shared parameters:

```
timeMin: [Monday of week]T00:00:00
timeMax: [Sunday of week]T23:59:59
timeZone: America/New_York
```

Run all calendar sources in the Tier 1 pass alongside Philly Ask A Punk and Luma.

| Calendar | ID | Filename | Category | Status |
|----------|----|----------|----------|--------|
| Trakt.tv film releases | `3c3o7i2bfqmvbss5lckns84vkedh4gqd@import.calendar.google.com` | `trakt-film-releases.json` | Film | ✅ Confirmed |
| Iffy Books | `uim84nkq226inhhqa44v98foigjak9us@import.calendar.google.com` | `iffy-books.json` | DIY / Literature | ✅ Confirmed Jun 2026 |
| Wooden Shoe Books | `t8qmive63n27mdj7gt03ntc2u8@group.calendar.google.com` | `wooden-shoe-books.json` | Literature / Politics | ✅ Confirmed Jun 2026 |

**When confirmed working:** Remove the ⚠️ note and update the Quick Reference table entry with confirmed date.

**To add new calendars:** Find the Google Calendar embed URL for a venue, extract the `src=` parameter, decode `%40` → `@`. That is the calendar ID. Test with `gcal_list_events` before adding to the table.

---

## iCal Parsing Reference

All iCal sources (Luma, Meetup groups, Wooden Shoe Books) parse VEVENT blocks with the same logic.

**DTSTART format varies by source:**

| Source | Format | Conversion |
|--------|--------|------------|
| Luma | UTC with Z suffix: `20260608T200000Z` | Subtract 4h (EDT) or 5h (EST) to get ET |
| Meetup groups | Local time with TZID: `DTSTART;TZID=America/New_York:20260608T200000` | Parse date string directly — no offset needed |
| Wooden Shoe Books | Local time with TZID (same as Meetup) | Parse date string directly — no offset needed |
| Philly Ask A Punk | Unix timestamp (UTC) | See filtering snippet below |

**Python filtering snippet (Philly Ask A Punk / Unix timestamps):**

```python
import datetime, json

UTC_OFFSET_ET = -4 * 3600  # EDT; use -5 * 3600 for EST (Nov–Mar)

events = json.loads(response_text)
today      = datetime.date.today()
week_start = today + datetime.timedelta(days=1)              # Monday (tomorrow)
week_end   = week_start + datetime.timedelta(days=6)         # Sunday

def in_week(event):
    ts = event["start_datetime"]
    d = datetime.datetime.utcfromtimestamp(ts + UTC_OFFSET_ET).date()
    if event.get("multidate") and event.get("end_datetime"):
        end_d = datetime.datetime.utcfromtimestamp(event["end_datetime"] + UTC_OFFSET_ET).date()
        return d <= week_end and end_d >= week_start
    return week_start <= d <= week_end

week_shows = [e for e in events if in_week(e)]
```

**Key VEVENT fields:**
- `SUMMARY` — event title
- `DTSTART` — start date/time
- `LOCATION` — venue address (may be empty for online events; flag as online-only)
- `DESCRIPTION` — full event description and URL
- `ORGANIZER;CN="..."` — host name (Luma only)

---

## Quick Reference: Extraction Method by Source

| Source | Method | Tier | Status |
|--------|--------|------|--------|
| Philly Ask A Punk | `fetch_raw.py` `/api/events` → JSON | 1 | ✅ Jul 2026 |
| Luma | `fetch_raw.py` iCal URL → parse VEVENT | 1 | ✅ Jul 2026 |
| The Rotunda | `fetch_raw.py` on `/events?date=YYYY-MM-DD` | 1 | ✅ Jul 2026 |
| Iffy Books | `gcal_list_events` MCP | 1 | ✅ Jun 2026 |
| Wooden Shoe Books | `gcal_list_events` MCP | 1 | ✅ Jun 2026 |
| Trakt.tv film releases | `gcal_list_events` MCP | 1 | ✅ Jun 2026 |
| R5 Productions | `fetch_raw.py` on `/events/` | 2 | ✅ Jul 2026 |
| Hive76 | `fetch_page_text.py` on `/classes/` | 2 | ✅ Jul 2026 |
| Philadelphia Film Society | `fetch_page_text.py` on 3 Fandango venue pages (filmadelphia.org is WAF-blocked domain-wide; WebSearch is the fallback) | 2 | ✅ Jul 2026 |
| Harriet's Bookshop | `fetch_page_text.py` on Eventbrite org page | 2 | ✅ Jul 2026; ⚠️ Main site still broken |
| Free Library | `fetch_page_text.py` | 2 | ✅ Jul 2026; needs realistic UA (Cloudflare) |
| PhilaMOCA | `fetch_raw.py` | 3 | ✅ Jul 2026 |
| cinéSPEAK | `fetch_raw.py` on `/cinema/`; `fetch_page_text.py` fallback if bot-challenge shown | 3 | ✅ Jul 2026 |
| Lightbox Film Center | `fetch_page_text.py` | 3 | ✅ Jul 2026 |
| Phillygoth.net | `fetch_raw.py` | 3 | ✅ Jul 2026 |
| Philadelphia Citizen | `fetch_raw.py` | 3 | ✅ Jul 2026 |
| WXPN | `fetch_page_text.py` on `xpn.org/concert-and-events/` | 3 | ✅ Jul 2026; thekey.xpn.org cert error, use xpn.org |
| Meetup groups (all 8) | `fetch_raw.py` iCal URL | 4 | ✅ Jul 2026 |
| Philly-Shows.com | `fetch_raw.py` | 5 | ✅ Jul 2026; ⚠️ Sparse (~2/week); spot-check only |
| Do215 | `fetch_page_text.py` on day URLs | 5 | ✅ Jul 2026; no provenance workaround needed |
| Billy Penn | WebSearch + fetch | 5 | ⚠️ Sunday morning only |
| Songkick | `fetch_raw.py` for page 1; `fetch_page_text.py` only for page 2+ if needed, capped at 4 pages | 5 | ✅ Jul 2026; ⚠️ Suno acquisition Nov 2025 |
| Bandsintown | ⛔ Dropped | — | Current-week only; no fix |
| Pennhurst Asylum | ⛔ Skip | — | No calendar; Oct/May only |

---

## Venue Address Lookup
 
Addresses for venues that appear in event listings but have no dedicated source entry. Venues with source entries (The Rotunda, PhilaMOCA, Lightbox, Harriet's, Iffy Books, Wooden Shoe Books, Free Library, Hive76) carry their address in the source entry itself.
 
| Venue | Address |
|-------|---------|
| First Unitarian Church | 2125 Chestnut St, Philadelphia, PA 19103 |
| Kung Fu Necktie | 1248 N Front St, Philadelphia, PA 19122 |
| Underground Arts | 1200 Callowhill St, Philadelphia, PA 19123 |
| Head House Books | 619 S 2nd St, Philadelphia, PA 19147 |
| Big Blue Marble Bookstore | 551 Carpenter Ln, Philadelphia, PA 19119 |
| Ortlieb's | 847 N 3rd St, Philadelphia, PA 19123 |
| Johnny Brenda's | 1201 N Frankford Ave, Philadelphia, PA 19125 |
| Cousin Danny's | 5001 Market St, Philadelphia, PA 19139 |
| Ruba Club | 416 Green St, Philadelphia, PA 19123 |
| Warehouse on Watts | 923 N Watts St, Philadelphia, PA 19123 |
| Ukie Club | 847 N Franklin St, Philadelphia, PA 19123 |
| Pennhurst Asylum | 601 N Church St, Spring City, PA 19475 (~35mi — Oct/May only) |

---

## Maintenance

Revalidate all ✅ sources at the start of each new season (Sep, Dec, Mar, Jun). Mark stale sources ⚠️ and test before the next run. When adding new sources, web-search the source name before adding to confirm it exists — do not add sources from memory alone.
