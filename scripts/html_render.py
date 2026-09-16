#!/usr/bin/env python3
"""Renders data/YYYY-MM-DD/_selections.json (+ _spotify.json) into the
weekly HTML report, per docs/v1/Skills/events-report-format/SKILL.md, then
regenerates docs/index.html to link the new week.

Deliberate divergences from v1's historical (LLM-rendered) output -- found
by diffing a real archived report (tests/golden/2026-06-22.html) against
its source _selections.json, and confirmed with Greg before building this:

- Category order is always the fixed 9-category order from SKILL.md. The
  real v1 output's category order varied day to day (e.g. Markets &
  Outdoors appeared both before and after Tech & Maker across different
  days of the same week) -- not a rule a script should try to reproduce.
- Venue, cost, title, and note text render verbatim from the JSON. v1's
  output contained ad hoc editorial shortening ("The Met Presented by
  Highmark" -> "The Met", "optional instructor donation (notaflof)" ->
  "optional donation") with no consistent rule across similar cases --
  reproducing it would mean guessing, which the pipeline explicitly avoids
  elsewhere.
- The "All Week / Recurring" table renders again. It was omitted for six
  published weeks on the grounds that _selections.json carried "no structured
  field a script could use to detect a 3+ day span" -- which was true of
  _selections.json but not of the pipeline: prepare_selection_input.py's
  group_recurring() has always emitted `occurrences`/`recurrence_count`, they
  just never survived merge_selections.py. They do now, so build_all_week()
  reads them directly rather than synthesizing prose the way v1 did.
  Recurring events are routed OUT of their day's category block and into the
  table (see is_all_week), which restores v1's behaviour of not also listing
  them inline -- with one deliberate exception for Top 3 picks.

Everything else was validated byte-for-byte against the archive: *(...)*
placeholder stripping, sold-out handling, Spotify link placement and
substring matching, and honorable-mention (SOLD OUT) bolding. Two
exceptions found later, both fixed here rather than left as "deliberate":
the "multiple showtimes" -> "+" suffix was appending to unparsed
placeholder text (e.g. "confirm showtimes+"); see display_time. And the
same-time sort tie-break does NOT match v1's order in any of the 4 real tie
groups checked (v1's own ordering there looks ad hoc, not a rule) -- v2's
tie-break (stable, original JSON array order) is kept as the more
defensible choice, but is not "validated against the archive," despite an
earlier version of this comment claiming it was.

A related, unfixed gap: only one Spotify link is representable per pick
(_spotify.json is one matched_text/url per title), so a pick naming two
acts can only link one. v1's report has 9 links across 8 Top 3 picks; v2
renders 8 -- see tests/golden/README.md.
"""

import argparse
import html
import itertools
import re
import sys
import urllib.parse
from collections import Counter, defaultdict
from datetime import date, datetime
from datetime import time as dt_time
from pathlib import Path

import jinja2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_yield
import common

TEMPLATES_DIR = common.REPO_ROOT / "templates"
DOCS_DIR = common.REPO_ROOT / "docs"
WEEKS_DIR = DOCS_DIR / "weeks"

# The full set of sources the pipeline watches, in display order. The footer
# renders all of them every week, but build_sources() now marks which ones
# actually contributed (with counts) and dims the rest -- the list alone used
# to claim credit for sources that sent nothing and stayed silent about ones
# that did; see build_sources.
# events-report-format/SKILL.md's Sources Footer section lists 21 sources
# (v1's set); this list intentionally diverges from it now that Collection
# is scripts/collect_week.py, not that spec: dropped Billy Penn and Songkick
# (bdc8a84, source-decommission precedent), then Free Library, Hive76,
# Harriet's Bookshop, and Philadelphia Citizen when the GHA migration
# dropped them from collection (none had a working deterministic parser and
# none earned their keep, or -- for Citizen -- had no home left as a
# model-read source once nothing upstream of Selection has a model in the
# loop; see philadelphia-sources/SKILL.md's Dropped section), and added
# Philly-Shows.com, which collect_week.py's SIMPLE_SOURCES does collect but
# v1 never listed. Keep this in sync with collect_week.py's
# SIMPLE_SOURCES/MEETUP_GROUPS/COLLECTOR_SOURCES registries.
SOURCES = [
    ("Do215", "https://do215.com"),
    ("Lightbox Film Center", "https://lightboxfilmcenter.org"),
    ("cinéSPEAK", "https://cinesp.net"),
    ("Philadelphia Film Society", "https://filmadelphia.org"),
    ("PhilaMOCA", "https://philamoca.org"),
    ("Phillygoth.net", "https://phillygoth.net"),
    ("Philly-Shows.com", "https://www.philly-shows.com"),
    ("Iffy Books", "https://iffybooks.net"),
    ("Wooden Shoe Books", "https://woodenshoebooks.org"),
    ("The Rotunda", "https://therotunda.org"),
    ("R5 Productions", "https://r5productions.com"),
    ("Philly Ask A Punk", "https://philly.askapunk.net"),
    ("The Key by WXPN", "https://xpn.org"),
    ("Meetup", "https://meetup.com"),
    ("Luma", "https://lu.ma"),
    ("Google Calendar", "https://calendar.google.com"),
]


# An event's `source` names the site it came from, not always under the name
# the footer uses for it. Only one such alias exists in the real data: events
# say "WXPN", the footer says "The Key by WXPN" (the publication, which is
# what SOURCES links to).
SOURCE_ALIASES = {"WXPN": "The Key by WXPN"}

# Two separators appear in the wild for multi-source attribution, sometimes in
# the same week: "Do215 / WXPN" and "Do215, WXPN". Both mean the same thing --
# the event was seen on both -- so both credit both.
SOURCE_SPLIT_RE = re.compile(r"[/,]")


def split_source_field(raw: str | None) -> list[str]:
    return [part.strip() for part in SOURCE_SPLIT_RE.split(raw or "") if part.strip()]


def normalize_source_name(raw: str) -> str:
    """Maps one source token onto its footer name.

    Meetup arrives per-group ("Meetup: Code & Coffee", "Meetup: DC 215",
    "Meetup: Philadelphia Horror" -- six distinct groups across the archive)
    and all of them collapse to the single "Meetup" footer entry, since that's
    what SOURCES lists and links.
    """
    name = raw.strip()
    if name.casefold().startswith("meetup:"):
        return "Meetup"
    return SOURCE_ALIASES.get(name, name)


def build_sources(days: list[dict]) -> list[dict]:
    """The footer, derived from the week's own events rather than asserted.

    Every known source still renders -- a silent week for a source is worth
    seeing -- but only contributors carry a count, and the rest are dimmed.

    Sources that contributed but aren't in SOURCES render unlinked rather than
    being dropped. That case is entirely historical: `Trakt.tv film releases`,
    `Free Library`, `Hive76`, `Philadelphia Citizen`, and `Songkick` were all
    retired from collection and removed from SOURCES, but they're still in the
    archived weeks this renderer re-renders, and a footer that silently omitted
    them would misreport those weeks in the opposite direction from the bug
    this function fixes.
    """
    counts: Counter[str] = Counter()
    for day in days:
        for event in day["events"]:
            for part in split_source_field(event.get("source")):
                counts[normalize_source_name(part)] += 1

    rows = []
    for name, url in SOURCES:
        rows.append({"name": name, "url": url, "count": counts.pop(name, 0)})
    for name in sorted(counts):
        rows.append({"name": name, "url": None, "count": counts[name]})
    return rows


def build_map_url(address: str | None) -> str | None:
    """A Google Maps search link for a Top 3 pick's address.

    `address` is the only geography in the system -- no coordinates, no
    neighborhood, and non-Top-3 events don't carry it at all -- and it was
    loaded and dropped until now. The `search/?api=1&query=` form is the
    documented cross-platform one: it opens the native app on iOS and Android
    and the web map elsewhere, so it needs no per-platform branching.
    """
    address = (address or "").strip()
    if not address:
        return None
    return (
        "https://www.google.com/maps/search/?api=1&query="
        + urllib.parse.quote_plus(address)
    )


def clean_cost(cost: str) -> str:
    return common.strip_placeholder_wrapper(cost)


def has_multiple_showtimes(note: str) -> bool:
    return "multiple showtimes" in (note or "").casefold()


def display_time(event_time: str, note: str) -> str:
    """Falls back to "Various" both when `event_time` is empty AND when it's
    a *(...)* placeholder -- e.g. "*(confirm showtimes)*" or "*(confirm
    details -- 7:00 AM listed, possible error)*". Regression guard: an
    earlier version stripped the placeholder wrapper and displayed the
    prose inside it verbatim, which produced "confirm showtimes+" (the
    "multiple showtimes" "+" suffix appended to non-time text) and a full
    sentence rendered into the narrow time column. Placeholder text belongs
    in `note`/`why`, not here -- this function should only ever emit an
    actual time or "Various"."""
    if common.is_placeholder_cost(event_time):
        return "Various"
    event_time = common.strip_placeholder_wrapper(event_time)
    if not event_time:
        return "Various"
    return event_time + ("+" if has_multiple_showtimes(note) else "")


def price_class_and_text(event: dict) -> tuple[str, str]:
    if event.get("sold_out"):
        return "sold-out", "SOLD OUT"
    cost = clean_cost(event.get("cost", ""))
    return ("price-free" if common.is_free_cost(cost) else "price-paid"), cost


def build_pick_name_html(pick: dict, spotify_entry: dict | None) -> str:
    title = pick["title"]
    if pick.get("is_music") and spotify_entry:
        matched = spotify_entry["matched_text"]
        idx = title.find(matched)
        if idx != -1:
            before = html.escape(title[:idx], quote=False)
            after = html.escape(title[idx + len(matched):], quote=False)
            label = html.escape(matched, quote=False)
            url = html.escape(spotify_entry["spotify_url"], quote=True)
            return f'{before}<a href="{url}">{label}</a>{after}'
    url = html.escape(pick["url"], quote=True)
    label = html.escape(title, quote=False)
    return f'<a class="event-link" href="{url}">{label}</a>'


def build_event_name_html(event: dict, is_top3: bool) -> str:
    url = html.escape(event["url"], quote=True)
    label = html.escape(event["title"], quote=False)
    prefix = "⭐ " if is_top3 else ""
    return f'<a href="{url}">{prefix}{label}</a>'


def build_honorable_mentions_html(mentions: list) -> str | None:
    if not mentions:
        return None
    parts = []
    for m in mentions:
        title = html.escape(m["title"], quote=False)
        title = title.replace("(SOLD OUT)", "(<strong>SOLD OUT</strong>)")
        venue = html.escape(m["venue"], quote=False)
        parts.append(f"{title} at {venue}")
    return " · ".join(parts)


def _parse_time_for_sort(event_time: str) -> dt_time | None:
    try:
        return datetime.strptime(event_time, "%I:%M %p").time()  # noqa: DTZ007 -- only .time() is used, no date/tz involved
    except (ValueError, TypeError):
        return None


# Rendered cards per category per day. A category's true count (used for the
# stats section) is unaffected -- this only bounds what's displayed.
CATEGORY_DISPLAY_CAP = 10


def _priority_key(
    event: dict, top3_titles: set, hm_titles: set, index: int
) -> tuple:
    """Top 3 picks sort first, then Honorable Mentions, then everything else
    chronological (ties preserve original array order, unparseable/empty
    times sort last within their tier -- both validated against the
    archived report, see module docstring). Applied before slicing to
    CATEGORY_DISPLAY_CAP so a busy category's cap can never silently drop
    something Selection already vetted -- a plain events[:N] slice would:
    checked against a real week, truncating Friday's 51 Music listings to
    the first 10 by start time cuts an actual Top 3 pick."""
    parsed = _parse_time_for_sort(event.get("time", ""))
    return (
        event["title"] not in top3_titles,
        event["title"] not in hm_titles,
        parsed is None,
        parsed or dt_time.min,
        index,
    )


def is_all_week(event: dict, top3_titles: set) -> bool:
    """True when this event belongs in the All Week table instead of a day's
    category block.

    A Top 3 pick is deliberately excluded even when it recurs: a pick
    disappearing from the day it was chosen for -- with a `why` blurb written
    about that day -- would be a worse bug than listing it twice. Such an
    event stays in its day and is simply absent from the table.
    """
    if event["title"] in top3_titles:
        return False
    return int(event.get("recurrence_count") or 0) >= common.RECURRING_THRESHOLD


def build_categories(day: dict, top3_titles: set) -> list[dict]:
    hm_titles = {mention["title"] for mention in day.get("honorable_mentions", [])}
    by_category = defaultdict(list)
    for event in day["events"]:
        if is_all_week(event, top3_titles):
            continue
        by_category[event["category"]].append(event)

    categories = []
    for label in common.CATEGORY_ORDER:
        events = by_category.get(label)
        if not events:
            continue
        ordered = sorted(
            enumerate(events),
            key=lambda pair: _priority_key(pair[1], top3_titles, hm_titles, pair[0]),
        )
        displayed = ordered[:CATEGORY_DISPLAY_CAP]
        view_events = []
        for _, event in displayed:
            is_top3 = event["title"] in top3_titles
            price_class, price_text = price_class_and_text(event)
            view_events.append(
                {
                    "name_html": build_event_name_html(event, is_top3),
                    "note": event.get("note") or None,
                    "venue": event["venue"],
                    "time_display": display_time(
                        event.get("time", ""), event.get("note", "")
                    ),
                    "price_class": price_class,
                    "price_text": price_text,
                }
            )
        # Say out loud when the cap actually dropped something. This is not
        # hypothetical: data/2026-06-22 has a 12-event Film & Cinema bucket,
        # so the published report for that week silently omitted 2 events
        # Selection had vetted, with nothing on the page to say so. "No
        # silent caps" is this project's own rule; surfacing the remainder
        # is the cheapest way to keep it.
        omitted = len(events) - len(displayed)
        categories.append(
            {
                "label": label,
                "events": view_events,
                "true_count": len(events),
                "omitted": omitted or None,
            }
        )
    return categories


def build_all_week(days: list[dict], top3_titles_by_date: dict[str, set]) -> list[dict]:
    """Rows for the "All Week / Recurring" table (events-report-format's
    spec section of the same name).

    One row per series, not per occurrence: a candidate is already collapsed
    to its earliest date by prepare_selection_input.py's group_recurring, but
    dedupe on (title, venue) anyway so a series that somehow survives on more
    than one day still yields a single row.

    **The dates column is only this week's occurrences and must never be
    rendered as the run's real span.** `occurrences` comes from
    group_recurring, which only ever saw the 7 days of the collected week --
    a museum exhibit running through December shows up with 3-7 dates here.
    Printing "Sep 2 - Sep 6" would state a run length manufactured by the
    collection window as though it were fact, the same class of error as the
    invented cost strings and the guessed venue address this project has
    already had to undo twice. Hence a "This week" column listing weekday
    abbreviations, and no start/end claim anywhere.
    """
    rows: dict[tuple[str, str], dict] = {}
    for day in days:
        top3_titles = top3_titles_by_date.get(day["date"], set())
        for event in day["events"]:
            if not is_all_week(event, top3_titles):
                continue
            key = (event["title"], event["venue"])
            if key in rows:
                continue
            occurrences = event.get("occurrences") or [day["date"]]
            weekdays = []
            for iso in occurrences:
                try:
                    weekdays.append(date.fromisoformat(iso).strftime("%a"))
                except ValueError:
                    continue
            _, price_text = price_class_and_text(event)
            rows[key] = {
                "title": event["title"],
                "venue": event["venue"],
                "category": event["category"],
                "days": ", ".join(weekdays),
                "price_text": price_text,
            }
    return list(rows.values())


def build_stats(selections: dict, manifest: dict, expected: dict) -> dict:
    """The "Week in Numbers" section: the collection funnel, per-category hit
    rate, source concentration, and a collection-health line.

    Three of the four blocks read `_selections.json` alone. Only the funnel's
    first stage and the health line need `_manifest.json`, and both are simply
    absent when it is (data/2026-06-22 predates v2 and has none) -- the section
    still renders, one tile shorter.
    """
    listed: Counter[str] = Counter()
    picks: Counter[str] = Counter()
    for day in selections["days"]:
        top3_titles = {pick["title"] for pick in day["top3"]}
        for category in build_categories(day, top3_titles):
            # true_count, not len(category["events"]) -- the display cap is a
            # rendering decision and must not shrink the number that reports
            # how much Selection actually listed.
            listed[category["label"]] += category["true_count"]
        for pick in day["top3"]:
            picks[pick["category"]] += 1

    # All Week / Recurring events are routed out of the day category blocks, so
    # build_categories() doesn't see them. They are still listed events of their
    # category -- just rendered in the table at the bottom rather than under a
    # day -- so they count toward both the funnel total and their category's
    # bar. Counting them in only one of the two is what an independent
    # re-derivation of these numbers caught: the bars summed to 83 while the
    # funnel directly above them said 90.
    top3_titles_by_date = {
        day["date"]: {pick["title"] for pick in day["top3"]}
        for day in selections["days"]
    }
    all_week_rows = build_all_week(selections["days"], top3_titles_by_date)
    for row in all_week_rows:
        listed[row["category"]] += 1

    category_rows: list[dict] = []
    max_listed = max(listed.values(), default=0)
    for label in common.CATEGORY_ORDER:
        count = listed.get(label, 0)
        if not count:
            continue
        top3 = picks.get(label, 0)
        category_rows.append(
            {
                "label": label,
                "listed": count,
                "top3": top3,
                # Percentages of the widest row, so bar length is comparable
                # across categories on one shared scale -- the magnitude story
                # a per-category waffle normalized to a fixed total destroys.
                "listed_pct": 100.0 * count / max_listed,
                "top3_pct": 100.0 * top3 / max_listed,
            }
        )
    category_rows.sort(key=lambda row: (-row["listed"], row["label"]))

    source_rows = [row for row in build_sources(selections["days"]) if row["count"]]
    source_rows.sort(key=lambda row: (-row["count"], row["name"]))
    max_source = source_rows[0]["count"] if source_rows else 0
    for row in source_rows:
        row["pct"] = 100.0 * row["count"] / max_source

    # `listed` already includes the All Week rows, so the category bars sum to
    # exactly this number -- the invariant test_build_stats_category_bars_sum_to
    # _the_funnel_listed_total pins.
    listed_total = sum(listed.values())
    stages: list[dict] = []
    manifest_sources = manifest.get("sources") or {}
    if manifest_sources:
        stages.append(
            {
                "label": "Collected",
                "value": sum(s.get("events") or 0 for s in manifest_sources.values()),
            }
        )
    stages.append({"label": "Candidates", "value": selections.get("total_events_after_dedup")})
    stages.append({"label": "Listed", "value": listed_total})
    stages.append({"label": "Top 3 picks", "value": sum(picks.values())})
    stages = [stage for stage in stages if stage["value"] is not None]
    for stage in stages:
        # Set explicitly, including on the first stage: an absent key is Undefined
        # in Jinja, and `Undefined is not none` is true, so a missing drop_pct
        # renders the delta line instead of skipping it.
        stage["drop_pct"] = None
        stage["drop_from"] = None
        stage["display"] = f"{stage['value']:,}"
    for previous, stage in itertools.pairwise(stages):
        if previous["value"]:
            stage["drop_pct"] = round(
                100.0 * (previous["value"] - stage["value"]) / previous["value"]
            )
            stage["drop_from"] = previous["label"].lower()

    health = None
    if manifest_sources:
        # check_yield.py is the authority on what "too few" means, floors and
        # all. Reusing it keeps the report from inventing a second rule -- and
        # crucially it exempts sources documented with min_expected: 0, so a
        # Meetup group that simply had no events this week is not reported as a
        # failure. A bare zero-yield count would cry wolf every single week.
        below_floor = check_yield.check_yield_floor(manifest, expected)
        contributed = sum(1 for s in manifest_sources.values() if s.get("events"))
        health = {
            "source_count": len(manifest_sources),
            "contributed": contributed,
            "below_floor": sorted(
                issue.source for issue in below_floor if issue.source
            ),
            "run_level_shortfall": any(issue.source is None for issue in below_floor),
        }

    return {
        "stages": stages,
        "categories": category_rows,
        "sources": source_rows,
        "health": health,
    }


def build_day_viewmodel(day: dict, spotify: dict) -> dict:
    day_date = date.fromisoformat(day["date"])
    top3_titles = {pick["title"] for pick in day["top3"]}

    top3 = []
    for pick in day["top3"]:
        spotify_entry = spotify.get(pick["title"]) if pick.get("is_music") else None
        # price_class_and_text is the same helper the listed-event cards use:
        # it already makes sold_out override cost, which is exactly the
        # inconsistency this fixes -- a sold-out pick used to render its ticket
        # price as though seats were still available, while the very same event
        # in the day's category block below said SOLD OUT in red.
        _, cost_text = price_class_and_text(pick)
        top3.append(
            {
                "rank": pick["rank"],
                "name_html": build_pick_name_html(pick, spotify_entry),
                "why": pick["why"],
                "venue": pick["venue"],
                "map_url": build_map_url(pick.get("address")),
                "time_display": display_time(pick.get("time", ""), ""),
                "cost_text": cost_text or None,
                "sold_out": bool(pick.get("sold_out")),
            }
        )

    categories = build_categories(day, top3_titles)
    return {
        "day_name": day["day_name"],
        # Weekday, not the ISO date: a report covers exactly one Mon-Sun span,
        # so "#saturday" is unambiguous within the page and survives being
        # typed from memory in a way "#2026-09-19" doesn't.
        "slug": day["day_name"].casefold(),
        "date_display": day_date.strftime("%B %-d"),
        # The day index shows true counts, before the display cap: it's the one
        # place on the page that states real scale, which is what made a "10 of
        # 51 shown" suffix on every category header unnecessary.
        "event_count": sum(category["true_count"] for category in categories),
        "top3": top3,
        "honorable_mentions_html": build_honorable_mentions_html(
            day.get("honorable_mentions", [])
        ),
        "categories": categories,
    }


def format_failure_note(raw: str) -> str:
    raw = raw.strip()
    if "(" in raw:
        name, _, rest = raw.partition("(")
        return f"{name.strip()} unavailable this week ({rest}"
    return f"{raw} unavailable this week"


def format_date_range(monday: date, sunday: date) -> str:
    if monday.month == sunday.month:
        return f"{monday:%B} {monday.day}–{sunday.day}, {sunday.year}"
    return f"{monday:%B} {monday.day} – {sunday:%B} {sunday.day}, {sunday.year}"


def _jinja_env() -> jinja2.Environment:
    return jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_report(week_dir: Path) -> str:
    selections = common.load_selections(week_dir)
    spotify = common.load_spotify(week_dir)
    # Optional by design: spotify_playlist.py exits 0 without writing
    # _playlist.json when Spotify auth or the API fails, and the header link
    # is simply omitted rather than the report failing to render.
    playlist_url = common.load_playlist(week_dir).get("playlist_url")

    monday = date.fromisoformat(selections["days"][0]["date"])
    sunday = date.fromisoformat(selections["days"][-1]["date"])
    date_range = format_date_range(monday, sunday)

    days = [build_day_viewmodel(day, spotify) for day in selections["days"]]
    top3_titles_by_date = {
        day["date"]: {pick["title"] for pick in day["top3"]} for day in selections["days"]
    }
    all_week = build_all_week(selections["days"], top3_titles_by_date)
    collection_failure_notes = [
        format_failure_note(f) for f in selections.get("collection_failures", [])
    ]

    template = _jinja_env().get_template("report.html.j2")
    return template.render(
        date_range=date_range,
        playlist_url=playlist_url,
        days=days,
        all_week=all_week,
        stats=build_stats(
            selections, common.load_manifest(week_dir), common.load_expected_yield()
        ),
        sources=build_sources(selections["days"]),
        collection_failure_notes=collection_failure_notes,
    )


def render_index() -> str:
    """Regenerates docs/index.html from scratch by scanning docs/weeks/*.html
    -- simpler and more robust than parsing and patching the existing file."""
    week_files = sorted(WEEKS_DIR.glob("*.html"), reverse=True)
    weeks = []
    for f in week_files:
        try:
            monday = date.fromisoformat(f.stem)
        except ValueError:
            continue
        sunday = common.week_dates(monday)[-1]
        weeks.append(
            {"href": f"weeks/{f.name}", "label": format_date_range(monday, sunday)}
        )

    template = _jinja_env().get_template("index.html.j2")
    return template.render(weeks=weeks)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a week's HTML report")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("html_path", type=Path, help="docs/weeks/YYYY-MM-DD.html")
    args = parser.parse_args()

    html_out = render_report(args.week_dir)
    args.html_path.parent.mkdir(parents=True, exist_ok=True)
    args.html_path.write_text(html_out, encoding="utf-8")

    WEEKS_DIR.mkdir(parents=True, exist_ok=True)
    index_out = render_index()
    (DOCS_DIR / "index.html").write_text(index_out, encoding="utf-8")

    day_count = html_out.count('class="day-header"')
    print(f"Report complete. {day_count} days rendered. File written: {args.html_path}")


if __name__ == "__main__":
    main()
