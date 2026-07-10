---
name: philadelphia-sources
description: Source collection instructions for the weekly This Week in Philadelphia events report. Use this skill when gathering events from web sources, Meetup groups, and Google Calendar for the weekly Philadelphia events report. Contains per-source URLs, known quirks, and extraction techniques. Trigger at the start of any Philadelphia weekly events collection run.
output_directory: ~/philly-events
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

Write all collected events to a dated directory under the `output_directory` specified in this skill's frontmatter (`~/philly-events` by default):

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
312 total events written to /Users/molo/Library/Mobile Documents/com~apple~CloudDocs/philly-events/2026-06-08/.
```

Then stop. Do not begin report generation in the same turn.
Report generation is a separate phase that reads from the output directory.

---

## Sources

### Tier 1 — web_fetch / MCP (no browser required)

Run these first. No browser session overhead; structured or semi-structured responses; write-and-forget is straightforward.

---

### 1. Philly Ask A Punk
**URL:** `https://philly.askapunk.net/api/events`
**Method:** `web_fetch` — returns JSON directly, no browser required
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
**Method:** `web_fetch` — returns iCal directly, no browser required
**Notes:** Increasingly dominant platform for tech, AI, and creative communities. Particularly useful for AI/vibe coding meetups, biotech/startup community events, and indie creative workshops. Philadelphia *discover* feed — featured/promoted events only, roughly 15–20 events per fetch spanning ~4 weeks. Low-noise.

**Parsing:** See iCal Parsing Reference. DTSTART is UTC (Z suffix) — apply EDT/EST offset. Each VEVENT includes SUMMARY, DTSTART, DESCRIPTION (full Luma URL + address + description), LOCATION, and ORGANIZER.

**✅ Confirmed Jun 2026** (refreshes every 12 hours per `X-PUBLISHED-TTL`)

---

### 3. The Rotunda
**URL:** `https://www.therotunda.org/events?date=YYYY-MM-DD` (any date in the target month)
**Example:** `https://www.therotunda.org/events?date=2026-06-01`
**Method:** `web_fetch` — returns full event listing, no browser required
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
**Fallback:** `get_page_text` on `https://iffybooks.net/` (scroll past the top item to get the full week; ✅ Confirmed Jun 2026)

---

### 5. Wooden Shoe Books
**Calendar ID:** `t8qmive63n27mdj7gt03ntc2u8@group.calendar.google.com`
**Method:** `gcal_list_events` via Google Calendar MCP connector (see Google Calendar Sources section)
**Address:** 704 South St, Philadelphia, PA 19147
**Notes:** Philadelphia's anarchist radical bookstore. High-alignment source for leftist politics + literature overlap. Consistent calendar of readings, film screenings, and community events.

⚠️ **Not yet confirmed via MCP — test before relying on.**

---

### Tier 2 — Simple `get_page_text`, low verbosity

Single-purpose venues with focused, low-prose event listings. Clean plain text, no JS extraction needed.

---

### 6. R5 Productions
**URL:** `https://r5productions.com/events/`
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Philadelphia's dominant mid-size indie promoter. Books First Unitarian Church, PhilaMOCA, Underground Arts, TLA, Johnny Brenda's, Ruba Club, Ukie Club, Cousin Danny's, Warehouse on Watts, Penn Museum, Philadelphia Ethical Society, Asian Arts Initiative, and Dell Music Center. Authoritative on sold-out status and exact pricing.

**✅ Confirmed Jun 2026** — `get_page_text` returns a clean forward-looking event list through ~6 months. Format per event:
```
[DAY, MON DD]
[Optional subtitle / tour name]
HEADLINER
Support act 1, Support act 2
[All Ages / 21 And Over]
Doors: X pm | Show: X pm
$XX.XX
Venue Name
[Buy Tickets / Sold Out - Click For Waiting List]
```

**Note on fundraiser shows:** R5 sometimes lists the beneficiary organization in the event subtitle (e.g. "A Fundraiser for Juntos Philadelphia"). Always capture this in the description field — it's high-value context for Greg's interests.

---

### 7. Hive76
**URL:** `https://www.hive76.org/classes/`
**Method:** Claude in Chrome → `get_page_text`
**Address:** Philadelphia hackerspace
**Notes:** Weekly open nights, member projects, electronics focus. Strong overlap with Greg's DIY electronics interest.

⚠️ **Use `/classes/` not `/events/`** — `/events/` redirects to a legacy wiki article. The actual calendar is at `/classes/` (confirmed Jun 2026). Open Houses run every Sunday 2:30–5pm (free, recurring).

**✅ Confirmed Jun 2026**

---

### 8. Philadelphia Film Society
**URL:** `https://filmadelphia.org/showtimes/`
**Method:** Claude in Chrome → `get_page_text` / WebSearch
**Notes:** Runs Philadelphia Film Center. Hosts PFS member screenings and curated film series. Good for arthouse and international cinema programming.

**✅ Confirmed Jun 2026** (WebSearch approach returned showtimes reliably)

---

### 9. Harriet's Bookshop
**URL:** `https://www.eventbrite.com/o/harrietts-bookshop-52538975313`
**Fallback:** `https://do215.com/venues/harriet-s-bookshop`
**Address:** 258 E Girard Ave, Philadelphia, PA 19125
**Method:** Claude in Chrome → `get_page_text` on the Eventbrite org page
**Notes:** Celebrates women authors, artists, and activists. Hosts Whiskey Fridays, major launch parties, and community events. Check for readings, signings, and workshops.

⚠️ **harrietsbookshop.com is unreliable** — the main site and `/pages/events` both return error pages consistently (confirmed Jun 2026). Use the Eventbrite org page as primary. The Do215 venue page is a useful secondary that catches events posted there but not Eventbrite.

---

### 10. Free Library of Philadelphia
**URL:** `https://libwww.freelibrary.org/programs/authorevents/`
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Extensive free literary programming, author talks, and community events across branches. Good source for high-profile author readings. Free admission.

**✅ Confirmed Jun 2026**

---

### Tier 3 — `get_page_text`, moderate verbosity

Venues and publications with editorial voice or mixed content. More prose per event but still manageable.

---

### 11. PhilaMOCA
**URL:** `https://www.philamoca.org/`
**Address:** 531 N 12th St, Philadelphia, PA 19123
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Philadelphia Mausoleum of Contemporary Art. The central hub for underground, horror, and weird culture in Philly. Check weekly — multiple recurring series run here:
- **Blood Sick Underground Cinema** — monthly horror screenings, 2nd Mondays
- **Psychotronic Film Society** — cult/horror screenings, twice monthly
- **Exhumed Films** — 35mm horror and exploitation events

**Secondary horror/occult sources** — check these after PhilaMOCA:
- **Phillygoth.net** (`https://phillygoth.net/`) — community-maintained dark/goth/occult calendar. Events that don't appear anywhere else.
- **Pennhurst Asylum** — ⛔ **skip in weekly runs**. No event calendar; on-demand ticket purchases only. 35 miles from Philly (~35mi). Check in **October** (haunted house season) and **around Paracon weekend in May** only.

**✅ Confirmed Jun 2026**

---

### 12. cinéSPEAK
**URL:** `https://cinespeak.org/cinema/`
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Arthouse film collective with politically engaged programming. Check for Third Thursdays (activist/documentary series) and other screenings. Events often free or PWYW.

⚠️ **Use `/cinema/` not the homepage** — `cinespeak.org` shows journal posts and mission copy with no event listings. `/events/` and `/screenings/` both 404 (confirmed Jun 2026).

**✅ Confirmed Jun 2026**

---

### 13. Lightbox Film Center
**URL:** `https://www.lightboxfilmcenter.org/`
**Address:** 1901 S 9th St (Bok Building), Philadelphia, PA 19148
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Philadelphia's premier repertory, experimental, documentary, and international cinema. Check weekly programming, series events, and special screenings. Free and low-cost screenings are common.

**✅ Confirmed Jun 2026**

---

### 14. Phillygoth.net
**URL:** `https://phillygoth.net/`
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Community-maintained dark/goth/occult calendar. Events that don't appear on any other source. Browse the events section. Listed under PhilaMOCA (§11) as a secondary horror/occult source — check both together.

**✅ Confirmed Jun 2026**

---

### 15. The Philadelphia Citizen — Good Citizen Calendar
**URL:** `https://thephiladelphiacitizen.org/good-citizen-calendar/`
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Curated picks with editorial voice. Good for community, civic, and arts events with a progressive angle.

**✅ Confirmed Jun 2026**

---

### 16. The Key by WXPN
**URL:** `https://xpn.org/concert-and-events/`
**Secondary:** `https://xpn.org/feature/concert-previews/`
**Method:** Claude in Chrome → `get_page_text`
**Notes:** WXPN (University of Pennsylvania) is one of the best indie/alternative/punk editorial outlets in the country. Good for discovering acts and finding Spotify links. The concert-previews archive has editorial roundup posts that are better for picks quality than the raw listing.

⚠️ **thekey.xpn.org has a certificate error** (confirmed Jun 2026) — do not use that subdomain. Use `xpn.org` directly. If `/concert-and-events/` output is sparse, try: `site:xpn.org "concert previews" philadelphia [month] [year]`

---

### Tier 4 — Meetup Groups (web_fetch iCal)

All Meetup groups now use the iCal method — no browser sessions required. Empty calendars are zero-cost to check.

---

### 17. Meetup Groups
**Method:** `web_fetch` on `https://www.meetup.com/[group-slug]/events/ical/`
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
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Dedicated Philadelphia hardcore and punk show tracker. Manually maintained. Sparse by design (confirmed Jun 2026 — ~2 shows/week vs. 9+ on Philly Ask A Punk for the same period). Lists prominent/R5-adjacent shows only, not the full DIY calendar. Quick pass only — treat as a supplementary spot-check after Philly Ask A Punk, not a primary source.

---

### 19. Do215
**URL pattern:** `https://do215.com/events/YYYY/M/D` (no zero-padding on month or day)
**Method:** Claude in Chrome → `get_page_text` on day-specific URLs
**Notes:** Sister site to Do512 — same platform, same React rendering, same URL structure.

**✅ Confirmed Jun 2026:** Navigate to each day's URL directly (e.g. `do215.com/events/2026/6/8`). `get_page_text` works cleanly and returns the full event listing. Navigate Mon–Sun separately. Filter out recurring "EVERY [DAY]" events.

**🚨 Scheduled-task context (no Chrome):** `web_fetch` requires URL provenance — a URL must appear in a prior message or fetch result before it can be retrieved. Do215 day URLs are not linked from the homepage, so they must be surfaced via WebSearch first. Before fetching any day's URL, run one WebSearch that includes all seven target URLs as query terms:

```
WebSearch query: "do215.com/events/YYYY/MM/DD" for each day Mon–Sun
Example: do215.com/events/2026/06/15 do215.com/events/2026/06/16 do215.com/events/2026/06/17 do215.com/events/2026/06/18 do215.com/events/2026/06/19 do215.com/events/2026/06/20 do215.com/events/2026/06/21
```

WebSearch returns those URLs in its links list, satisfying provenance. Then `web_fetch` each day URL that appeared in results. Any day URL that did not appear in results should be written as `status: failed, reason: "provenance — URL not returned by WebSearch"`.

Note: Do215 accepts both zero-padded (`2026/06/15`) and non-padded (`2026/6/15`) day URLs — use zero-padded format for WebSearch since that is what search engines index.

**🚨 FALLBACK — WebSearch:** If `get_page_text` fails:
```
query: "site:do215.com/events/YYYY/M/D" OR "do215.com philadelphia events [Day Month Date 2026]"
```

<details>
<summary>JS extraction (non-day-specific pages only)</summary>

If you ever need to scrape the Do215 homepage or `/events/` (not the standard day-URL flow), use JavaScript — those pages use React rendering and `get_page_text` will fail with "page body too large." Do NOT use regex literals — use `.includes()` and `.startsWith()`.

```javascript
const year = new Date().getFullYear().toString();
let events = [];
document.querySelectorAll('a[href*="/events/"]').forEach(a => {
  const href = a.href;
  if (href.includes('/events/' + year + '/') && !href.includes('?')) {
    const text = a.innerText.trim();
    if (text && text.length > 3) {
      const parent = a.closest('[class*="event"]') || a.parentElement;
      const venue = parent ? parent.innerText.replace(text, '').trim().slice(0, 80) : '';
      events.push(text + ' | ' + venue);
    }
  }
});
[...new Set(events)].slice(0, 30).join('\n');
```
Paginate with `slice(0, 25)` then `slice(20, 45)` to get the full list.
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
**Method:** Claude in Chrome → `get_page_text`
**Notes:** Broadest music aggregator — 1,252+ events for June 2026 alone. Good for catching shows not on R5, Do215, or Philly Ask A Punk (smaller indie acts on Johnny Brenda's, Ortlieb's, MilkBoy, etc.).

⚠️ **Platform stability risk:** Songkick was acquired by Suno (generative AI) in November 2025. Revalidate this source at each quarterly check.

**✅ Confirmed Jun 2026** — `get_page_text` works and returns event names, venues, and dates.

**Two issues to manage:**

1. **Pagination** — paginates at ~10 events per page. For week 2 of the month (Jun 8–14), page 1 ends around Jun 10; append `?page=2` for Jun 11–14. For weeks 3–4, go to page 3+.

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
| Philly Ask A Punk | `web_fetch` `/api/events` → JSON | 1 | ✅ Jun 2026 |
| Luma | `web_fetch` iCal URL → parse VEVENT | 1 | ✅ Jun 2026 |
| The Rotunda | `web_fetch` on `/events?date=YYYY-MM-DD` | 1 | ✅ Jun 2026 |
| Iffy Books | `gcal_list_events` MCP | 1 | ✅ Jun 2026 |
| Wooden Shoe Books | `gcal_list_events` MCP | 1 | ✅ Jun 2026 |
| Trakt.tv film releases | `gcal_list_events` MCP | 1 | ✅ Jun 2026 |
| R5 Productions | `get_page_text` on `/events/` | 2 | ✅ Jun 2026 |
| Hive76 | `get_page_text` on `/classes/` | 2 | ✅ Jun 2026 |
| Philadelphia Film Society | `get_page_text` / WebSearch | 2 | ✅ Jun 2026 |
| Harriet's Bookshop | `get_page_text` on Eventbrite org page | 2 | ⚠️ Main site broken |
| Free Library | `get_page_text` | 2 | ✅ Jun 2026 |
| PhilaMOCA | `get_page_text` | 3 | ✅ Jun 2026 |
| cinéSPEAK | `get_page_text` on `/cinema/` | 3 | ✅ Jun 2026 |
| Lightbox Film Center | `get_page_text` | 3 | ✅ Jun 2026 |
| Phillygoth.net | `get_page_text` | 3 | ✅ Jun 2026 |
| Philadelphia Citizen | `get_page_text` | 3 | ✅ Jun 2026 |
| WXPN | `get_page_text` on `xpn.org/concert-and-events/` | 3 | ⚠️ thekey.xpn.org cert error; use xpn.org |
| Meetup groups (all 8) | `web_fetch` iCal URL | 4 | ✅ Jun 2026 |
| Philly-Shows.com | `get_page_text` | 5 | ⚠️ Sparse (~2/week); spot-check only |
| Do215 | `get_page_text` on day URLs | 5 | ✅ Jun 2026 |
| Billy Penn | WebSearch + fetch | 5 | ⚠️ Sunday morning only |
| Songkick | `get_page_text` on `/month-YYYY` URL | 5 | ✅ Jun 2026; ⚠️ Suno acquisition Nov 2025 |
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
