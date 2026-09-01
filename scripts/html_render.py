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
import sys
from collections import defaultdict
from datetime import date, datetime
from datetime import time as dt_time
from pathlib import Path

import jinja2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

TEMPLATES_DIR = common.REPO_ROOT / "templates"
DOCS_DIR = common.REPO_ROOT / "docs"
WEEKS_DIR = DOCS_DIR / "weeks"

# Fixed footer source list, in display order -- always shown in full
# regardless of which sources actually contributed events this week.
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


def build_day_viewmodel(day: dict, spotify: dict) -> dict:
    day_date = date.fromisoformat(day["date"])
    top3_titles = {pick["title"] for pick in day["top3"]}

    top3 = []
    for pick in day["top3"]:
        spotify_entry = spotify.get(pick["title"]) if pick.get("is_music") else None
        top3.append(
            {
                "rank": pick["rank"],
                "name_html": build_pick_name_html(pick, spotify_entry),
                "why": pick["why"],
                "venue": pick["venue"],
                "time_cost": " · ".join(
                    part
                    for part in [
                        display_time(pick.get("time", ""), ""),
                        clean_cost(pick.get("cost", "")),
                    ]
                    if part
                ),
            }
        )

    return {
        "day_name": day["day_name"],
        "date_display": day_date.strftime("%B %-d"),
        "top3": top3,
        "honorable_mentions_html": build_honorable_mentions_html(
            day.get("honorable_mentions", [])
        ),
        "categories": build_categories(day, top3_titles),
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
        days=days,
        all_week=all_week,
        sources=[{"name": name, "url": url} for name, url in SOURCES],
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
