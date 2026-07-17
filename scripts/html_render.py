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
- Venue, cost, and title text render verbatim from the JSON. v1's output
  contained ad hoc editorial shortening ("The Met Presented by Highmark"
  -> "The Met", "optional instructor donation (notaflof)" -> "optional
  donation") with no consistent rule across similar cases -- reproducing
  it would mean guessing, which the pipeline explicitly avoids elsewhere.
- The "All Week / Recurring" table is omitted. It requires synthesized
  prose schedule summaries ("Through July 4, daily from 11am") that don't
  exist as structured data anywhere in _selections.json.

Everything else was validated byte-for-byte against the archive: the
"multiple showtimes" -> time "+" suffix rule, *(...)* placeholder
stripping, sold-out handling, Spotify link placement and substring
matching, and honorable-mention (SOLD OUT) bolding.
"""

import argparse
import html
import sys
from collections import defaultdict
from datetime import date, datetime, time as dt_time
from pathlib import Path

import jinja2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

TEMPLATES_DIR = common.REPO_ROOT / "templates"
DOCS_DIR = common.REPO_ROOT / "docs"
WEEKS_DIR = DOCS_DIR / "weeks"

# Fixed footer source list, in display order -- always shown in full
# regardless of which sources actually contributed events this week.
# Per events-report-format/SKILL.md's Sources Footer section.
SOURCES = [
    ("Do215", "https://do215.com"),
    ("Lightbox Film Center", "https://lightboxfilmcenter.org"),
    ("cinéSPEAK", "https://cinesp.net"),
    ("Philadelphia Film Society", "https://filmadelphia.org"),
    ("PhilaMOCA", "https://philamoca.org"),
    ("Phillygoth.net", "https://phillygoth.net"),
    ("Harriet's Bookshop", "https://harrietsbookshop.com"),
    ("Iffy Books", "https://iffybooks.net"),
    ("Wooden Shoe Books", "https://woodenshoebooks.org"),
    ("The Rotunda", "https://therotunda.org"),
    ("R5 Productions", "https://r5productions.com"),
    ("Free Library", "https://libwww.freelibrary.org"),
    ("Billy Penn", "https://billypenn.com"),
    ("Philadelphia Citizen", "https://thephiladelphiacitizen.org"),
    ("Philly Ask A Punk", "https://philly.askapunk.net"),
    ("The Key by WXPN", "https://xpn.org"),
    ("Meetup", "https://meetup.com"),
    ("Hive76", "https://hive76.org"),
    ("Luma", "https://lu.ma"),
    ("Songkick", "https://songkick.com"),
    ("Google Calendar", "https://calendar.google.com"),
]


def strip_placeholder_wrapper(text: str) -> str:
    """Strips a literal *(...)* placeholder wrapper (e.g. "*(confirm
    details)*" -> "confirm details"). Used for both cost and time -- both
    fields use this convention to flag uncertain/unconfirmed values."""
    text = (text or "").strip()
    if text.startswith("*(") and text.endswith(")*"):
        return text[2:-2].strip()
    return text


# Cost values treated as free beyond the literal "free" (case-insensitive).
# Validated against tests/golden/2026-06-22.html; extend if a future week
# surfaces another synonym, but don't guess ahead of evidence.
_FREE_SYNONYMS = {"free", "no cover"}


def clean_cost(cost: str) -> str:
    return strip_placeholder_wrapper(cost)


def is_free_cost(cost: str) -> bool:
    return clean_cost(cost).casefold() in _FREE_SYNONYMS


def has_multiple_showtimes(note: str) -> bool:
    return "multiple showtimes" in (note or "").casefold()


def display_time(event_time: str, note: str) -> str:
    event_time = strip_placeholder_wrapper(event_time)
    if not event_time:
        return "Various"
    return event_time + ("+" if has_multiple_showtimes(note) else "")


def price_class_and_text(event: dict) -> tuple[str, str]:
    if event.get("sold_out"):
        return "sold-out", "SOLD OUT"
    cost = clean_cost(event.get("cost", ""))
    return ("price-free" if is_free_cost(cost) else "price-paid"), cost


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
        return datetime.strptime(event_time, "%I:%M %p").time()
    except (ValueError, TypeError):
        return None


def build_categories(day: dict, top3_titles: set) -> list[dict]:
    by_category = defaultdict(list)
    for event in day["events"]:
        by_category[event["category"]].append(event)

    categories = []
    for label in common.CATEGORY_ORDER:
        events = by_category.get(label)
        if not events:
            continue
        # Stable sort by parsed time ascending; unparseable/empty times
        # sort last, ties preserve original array order (both validated
        # against the archived report -- see module docstring).
        ordered = sorted(
            enumerate(events),
            key=lambda pair: (
                _parse_time_for_sort(pair[1].get("time", "")) is None,
                _parse_time_for_sort(pair[1].get("time", "")) or dt_time.min,
                pair[0],
            ),
        )
        view_events = []
        for _, event in ordered:
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
        categories.append({"label": label, "events": view_events})
    return categories


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
    collection_failure_notes = [
        format_failure_note(f) for f in selections.get("collection_failures", [])
    ]

    template = _jinja_env().get_template("report.html.j2")
    return template.render(
        date_range=date_range,
        days=days,
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


def main():
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
