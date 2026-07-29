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
| do215 | 20 | Fixed — deterministic JSON API |
| philadelphia-film-society | 5 | No deterministic route found (see below) |
| lightbox-film-center | 4 | Not yet built — Wix `data-hook` index + JSON-LD detail pages |
| wxpn | 4 | Fixed — deterministic WordPress REST API |
| cinespeak | 4 | Not yet built — clean WordPress block markup found |
| songkick | 2 | Not yet built — per-listing JSON-LD found, but intermittent 406 rate-limiting needs handling |
| billy-penn | 0 | Structurally uncollectable at the scheduled run time (see below) |

Together these are 39 of 136 rows (29%) of everything the report has ever published. The 8 Meetup
feeds, `philly-shows`, `free-library`, and `harriets-bookshop` were ruled out of scope — they were
zero in v1's run too, i.e. genuinely quiet, not broken.

## Sources that don't have a deterministic fix

- **philadelphia-film-society** — Fandango's only JSON-LD is `MovieTheater` (no showtimes);
  showtimes are JS-rendered. The internal API (`fandango.com/napi/theaterMovieShowtimes/...`)
  returned `403 Session expired or invalid token`. Fandango's own JSON-LD names its real backend as
  "Agile Ticketing" (`agiletix.com`), which was not probed — the highest-value unexplored lead for
  this source. Stays browser-only (`fetch_page_text.py`) until then.
- **billy-penn** — its weekly events-calendar post is published Monday morning *of* the target
  week, confirmed via its own WordPress REST API (`billypenn.com/wp-json/wp/v2/posts?slug=...`).
  Collection runs Sunday at 2am ET, before the post exists. No parser fixes a source that isn't
  live yet at fetch time.

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

A songkick parser (per-listing JSON-LD found, but intermittent 406 rate-limiting needs handling —
the highest-effort remaining source); a PFS fix contingent on the unprobed Agile Ticketing lead; the
two latent bugs found along the way (DST offset hardcoded in `luma.py`/`philly_ask_a_punk.py`;
year-inference breaking across a Dec/Jan boundary in `r5_productions.py`/`phillygoth.py`); and
reassessing whether `da92183`'s serial-execution rule still needs relaxing now that the expensive
tail is mostly cheaper.
