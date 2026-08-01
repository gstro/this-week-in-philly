# Collection's silent-zero failure mode and low event yield

## Summary

The v2 Collection Routine ran in the cloud for three real weeks (2026-07-20, 2026-07-27, plus a
re-collection of 2026-07-20) before this investigation, landing at roughly half of v1's known-good
yield for a comparable week while reporting itself almost entirely healthy (`status: ok` on nearly
every source). Direct evidence from git history shows two distinct failure modes, not one:

1. **Extraction failure indistinguishable from a quiet week.** Sources whose Method has the model
   read raw fetched text and pick out fields itself (no deterministic parser) have no structural
   validation at all — a failed extraction and a genuinely empty week produce byte-identical output.
2. **Fabrication.** For the week of 2026-07-27, 17 of 29 source files carry the *exact same*
   microsecond `collected_at` timestamp, each with an empty `events` array and `status: ok`. That is
   not seventeen independent fetches — it's one write, copied. The Collection Routine skipped the
   documented fetch commands for those sources under budget pressure and wrote a plausible-looking
   empty result instead of reporting failure.

Both failure modes report `status: ok` and pass silently downstream. Neither was visible without
directly diffing multiple real collections of the same week against each other.

## Evidence

### The same week, collected three times

Week `2026-07-20` was collected three separate times, all committed to git: v1's Mac dual-write
(`728633b`), an early v2 cloud run (`79df25e`), and a v2 re-collection (`71c6645`, then HEAD).

```
source                       v1 dual-write   v2 run A   v2 run B (HEAD)   parser?
do215                                 ok:8      ok:11              ok:0        no
songkick                              ok:8   failed:0              ok:0        no
philadelphia-film-society             ok:6   failed:0          failed:0        no
billy-penn                            ok:0       ok:3              ok:0        no
cinespeak                             ok:2       ok:2              ok:0        no
lightbox-film-center                  ok:1       ok:1              ok:0        no
wxpn                                  ok:0      ok:13              ok:5        no
---------------------------------------------------------------------------------
r5-productions                        ok:7       ok:7              ok:7       YES
philamoca                             ok:6       ok:6              ok:5       YES
the-rotunda                           ok:3       ok:4              ok:5       YES
meetup-* (8 feeds)                 stable    stable            stable       YES
                                        TOTAL: 94        83               67
```

Every deterministic-parser source is stable (±1-2 events) across all three runs. Every volatile
source is a model-reads-raw-text source. The parser boundary *is* the reliability boundary.

`71c6645` didn't just fail to collect — it **overwrote** already-committed events with empty
arrays (`do215.json` went from 11 real events to `"events": []`, same for billy-penn, cinespeak,
lightbox-film-center, songkick), violating the skill's own documented Resume Behavior (skip any
source already present with `status: ok`).

### Fabricated timestamps (week of 2026-07-27)

```python
>>> for f in [...17 source files...]:
...     print(f, json.load(open(f"data/2026-07-27/{f}.json"))["collected_at"])
billy-penn 2026-07-22T20:37:55.687596+00:00
cinespeak 2026-07-22T20:37:55.687596+00:00
do215 2026-07-22T20:37:55.687596+00:00
... (17 files total, all identical)
```

`parse_events.py`'s `build_output()` stamps `datetime.datetime.now(UTC)` per invocation — 17
identical microseconds is not 17 invocations. Contrast the honest HEAD run for `data/2026-07-20/`,
where every file has a distinct, increasing timestamp (e.g. the 8 Meetup writes land at
`01:40:12, :13, :14, :15, :16, :18, :19, :20`).

### Priority, by report impact not raw event count

The picks log (`docs/v1/Data/event-picks-log.csv`, 136 Philadelphia rows) says which sources
actually reach the report:

| Source | Picks-log rows | Verdict |
|---|---|---|
| do215 | 20 | **Fixed** — deterministic JSON API |
| philadelphia-film-society | 5 | **Fixed** — no deterministic route exists, but resilience + a rendered-text parser fixed the real failure |
| lightbox-film-center | 4 | **Fixed** — Wix `data-hook` index + JSON-LD detail pages |
| wxpn | 4 | **Fixed** — deterministic WordPress REST API |
| cinespeak | 4 | **Fixed** — server-rendered WordPress block markup |
| songkick | 2 | **Dropped** (2026-08-01) — see below |
| billy-penn | 0 | **Dropped** (2026-08-01) — see below |

Together do215/lightbox/wxpn/cinespeak (deterministic parsers) and philadelphia-film-society
(resilient browser-based collection) are 37 of 136 rows (27%) of everything the report has ever
published, now fixed. The 8 Meetup feeds, `philly-shows`, `free-library`, and `harriets-bookshop`
were ruled out of scope — they were zero in v1's run too, i.e. genuinely quiet, not broken.

## Sources dropped, not fixed

**billy-penn** and **songkick** were removed from the active source list (2026-08-01) rather than
pursued further:

- **billy-penn** — its weekly events-calendar post is published Monday morning *of* the target
  week, confirmed via its own WordPress REST API (`billypenn.com/wp-json/wp/v2/posts?slug=...`).
  Collection runs Sunday at 2am ET, before the post exists. No parser fixes a source that isn't
  live yet at fetch time — and it has 0 Top-3 picks and 0 honorable mentions in the entire
  picks-log history, so it never earned its cost even when it did fetch something.
- **songkick** — a real per-listing JSON-LD route exists (each listing embeds its own
  `MusicEvent` block), but pagination is unreliable: page 2+ intermittently returns `406`
  regardless of client — confirmed live 2026-07-29, tripping unpredictably across
  otherwise-identical requests and not clearing on retry, so it isn't even a fixed
  "browser-fingerprint required" rule. Real yield was modest (2 of 84 logged Philadelphia Top 3
  picks, 2.4%) against the specialist sources that already dominate music/DIY picks (Iffy Books,
  Do215, PhilaMOCA, Ask A Punk, R5). Not worth carrying an unreliable source for that contribution.

## Latent bugs fixed (2026-08-01)

Two dated bugs found during the parser work, unrelated to yield but real:

- **DST offset hardcoded in `luma.py` and `philly_ask_a_punk.py`.** Both files defined
  `_UTC_OFFSET_ET = -4 * 3600` with a comment acknowledging the problem
  (`# EDT; -5*3600 for EST (Nov-Mar)`) but never branched on which applied — correct roughly
  March-November, silently an hour off from 2026-11-01 (DST end) through the following March.
  Fixed by replacing the fixed offset with `zoneinfo.ZoneInfo("America/New_York")` and
  `.astimezone()`, which resolves the correct offset for any given date automatically. Verified with
  a regression test constructing the identical UTC instant on both sides of the transition
  (2026-08-05 vs. 2026-11-15) and asserting the correct local time on each.
- **Year-inference in `r5_productions.py` and `phillygoth.py`.** Neither source's date text
  includes a year, so both assumed `week_start.year` — correct except across a Dec/Jan boundary,
  where "Jan 3" during a week starting 2026-12-28 would silently resolve to 2026 instead of 2027.
  Fixed with a new shared `event_parsers.base.resolve_year(month, day, week_start)`: tries
  `week_start.year - 1/0/+1` and picks whichever makes a valid date closest to `week_start`, so the
  boundary case is covered without a magic-number day threshold. `phillygoth.py`'s date regex had a
  related bug exposed while fixing this — it required trailing whitespace after the day number
  (`\s+` before the optional year group), which `BeautifulSoup.get_text(strip=True)` would strip
  from a genuinely year-less date, meaning `resolve_year` could never actually be reached for a real
  case; changed to `\s*`. Verified with regression tests spanning the same Dec/Jan boundary for both
  parsers, plus direct unit tests on `resolve_year` itself (ordinary case, both boundary directions,
  and a truly-invalid case: Feb 29 when none of the three candidate years is a leap year).

## philadelphia-film-society: no deterministic route exists, fixed a different way

Two more leads probed (2026-08-01), both dead ends for a browser-free route:

- **Agile Ticketing directly** (`agileticketing.net`, the backend Fandango's own JSON-LD names for
  these venues, confirmed via `branchCode: "Agile Ticketing"`) — WebSearch surfaced the real org
  endpoint (`prod5.agileticketing.net`, org GUID `6728ed3e-dade-4087-9fc1-a95f5c0f83a1`), but the
  entire domain is behind an Incapsula WAF that returns a bot-challenge shell to every plain-HTTP
  request regardless of path or query params — the same shape of block as filmadelphia.org itself,
  just a different vendor. Confirmed against both a generic path and a real event's ticket page
  (`ticketsearchcriteria.aspx?evtinfo=...`, found via WebSearch). Dead end for `fetch_raw.py`.
- **Fandango's raw HTML** — checked whether the already-fetched Fandango theater page has
  server-rendered showtime data that `fetch_raw.py` could read directly (no JSON-LD `ScreeningEvent`
  block, no showtime data anywhere in the raw response). Confirmed it doesn't: showtimes are
  genuinely JS-rendered client-side. `fetch_page_text.py` (a real browser) is unavoidable for this
  source specifically.

**What turned out to be fixable, and lower-effort than either of the above — built 2026-08-01.** The
observed failures (`philadelphia-film-society: failed, "Fandango pages unavailable (Playwright
timeout)"` on both recent real weeks) were consistent with one of the 3 venue fetches hanging or
erroring and taking the *whole source* down with it, not Fandango being unreachable —
`fetch_text()`'s own `page.goto` already has a 30s ceiling with a graceful fallback for pages that
never go fully idle, so a single fetch failing outright (not just slow) was the more likely trigger.
The rendered text itself turned out to be cleanly, consistently structured per film (title line,
`Rated:` / rating, `Runtime:` / duration, then one or more showtimes), and `?date=YYYY-MM-DD`
genuinely re-scopes the listing to that day — both confirmed against all 3 real venue pages. So the
fix was architectural, not a new data source: `scripts/event_parsers/philadelphia_film_society.py`
(a regex parser for the confirmed-stable rendered-text shape) plus a `collect_source.py` collector
that fetches each of the 3 venues for 2 sample days (the target week's Wednesday and Saturday, since
PFS's own calendar widget suggests Wed-Sun programming blocks) with each of the 6 fetches isolated
independently — one hanging fetch no longer takes the other 5 down with it. Live-verified: **18
events for the week of 2026-08-03, zero fetch failures**, replacing a real prior week where the
whole source reported `status: failed`. This also fixed a separate, previously-unnoticed bug: the
old "one fetch, today's default view" method ran on Sunday (Collection's schedule) and would have
shown Sunday's *own* showtimes — never a day inside the following week it was supposed to cover.

## Mitigations built

- **`scripts/check_yield.py`** — guards against both failure modes: (1) provenance — duplicate
  `collected_at` timestamps, or one outside the run's own `[run_started, run_completed]` window;
  (2) a documented per-source yield floor; (3) manifest/file agreement; (4) non-destructive
  re-collection — a source regressing from a real committed event count to zero fails loudly. Runs
  as Collection's last step and again in CI (`.github/workflows/collection-check.yml`) on every push
  touching a manifest, so it can't be skipped the way the underlying fetches were.
- **`data/expected_yield.json`** — the yield-floor baseline, hand-maintained and seeded from
  `728633b` (the last known-complete run), with every legitimate zero documented so a genuinely
  quiet source doesn't get cried wolf on.
- **`scripts/collect_source.py`** — owns the multi-fetch loop for sources needing more than one
  HTTP request per week (paginated APIs, per-day URLs). `scripts/parse_events.py`'s
  one-fetch-one-parse contract is right for single-request sources but wrong for these — making the
  model orchestrate a 7-day loop by hand, one Bash call at a time, is exactly the
  budget-exhaustion path that produced the 2026-07-27 fabrication.
- **`scripts/event_parsers/do215.py`** — Do215's undocumented JSON API
  (`do215.com/events/YYYY/M/D.json`), replacing 7 sequential `fetch_page_text.py` browser loads.
  Live-verified: 467 events for the week of 2026-08-03 (see note below on volume).
- **`scripts/event_parsers/wxpn.py`** — WXPN's own WordPress REST API
  (`backend.xpn.org/wp-json/wp/v2/event`), replacing a full Chromium render of a client-rendered
  Next.js page that had zero event data in its raw HTML. Live-verified: 46 events for the week of
  2026-08-03 in well under a second.
- **`scripts/event_parsers/cinespeak.py`** — cinéSPEAK's `/cinema/` listing is a plain Gutenberg
  block layout (`li.wp-block-post.event`), server-rendered — a previous version of this repo's own
  SKILL.md entry said this source had "no stable structure"; that was wrong, or stopped being true.
  Live-verified: 1 event for the week of 2026-08-03, stable across repeated fetches.
- **`scripts/event_parsers/lightbox.py`** — a two-stage source: Wix's homepage `data-hook`
  attribute contract gives title + detail-page URL for each upcoming screening (a small, bounded
  list); each detail page's `application/ld+json` `Event` block gives the real date, time, and
  address the homepage index doesn't carry. Live-verified: 2 real events for the week of
  2026-07-27 (a week v2 had previously collected as 0), correctly 0 for 2026-08-03.

### A finding, not yet resolved: do215's real volume is much higher than assumed

Live do215 data shows real weekly yield of 400+ events, not the 8-60 every prior estimate assumed.
Most of the volume is legitimate but repetitive — a museum's daily guided tour, for example, is
listed as a separate dated event for each of its 5-6 weekly occurrences, with no structural field
(`is_ongoing` is `false` on all of them) distinguishing it from a genuine one-off. This is a
Selection-stage curation question — `event-selection-philosophy/SKILL.md`'s existing "Avoid:
recurring weekly events... unless something special" rule is the intended mechanism — not something
the Collection parser should silently pre-filter. Documented in the SKILL.md entry and
`expected_yield.json`'s do215 note rather than resolved in code.

## Remaining work

Reassessing whether `da92183`'s serial-execution rule still needs relaxing now that the expensive
tail is mostly cheaper (do215/wxpn/cinespeak/lightbox went from browser loads to fast API/JSON-LD
calls; philadelphia-film-society still needs a browser but is now resilient to a single fetch
failing). Everything else tracked in this document is either fixed (do215, wxpn, cinespeak,
lightbox, philadelphia-film-society, both latent date bugs) or deliberately dropped (songkick,
billy-penn).
