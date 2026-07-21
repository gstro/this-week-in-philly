#!/usr/bin/env python3
"""Deterministically parses fetched source content into the Collection event schema.

Companion to fetch_raw.py: that script fetches a URL with no model in the
loop; this one parses the result with no model in the loop either. Together
they replace a step that used to require Claude to read raw HTML/iCal/JSON
and manually transcribe events -- confirmed live (2026-07-21) that this
produces real, undetected bugs: Claude wrote a one-off regex parser for R5
Productions with a capturing-group bug that silently matched a 12-character
date fragment instead of the real event block, so every event was dropped
and the source reported 0 events with no error, despite fetch_raw.py having
returned the complete, correct page. philadelphia-sources/SKILL.md now
prohibits ad hoc parsing scripts for exactly this reason -- this module is
the tested, version-controlled replacement, not another one-off script.

Usage:
    python scripts/fetch_raw.py <url> | python scripts/parse_events.py \\
        <parser> --source-name "R5 Productions" \\
        --week-start 2026-07-20 --week-end 2026-07-26

Each parser is a small, independently testable function against a known,
stable markup/format shape (see tests/test_parse_events.py for real fixture
data per source). A parser that finds its container elements but zero of
them fall in the target week returns an empty list -- a normal, valid
result (a genuinely quiet week). A parser that finds *no container
elements at all* raises ParseError instead of silently returning an empty
list, since that almost always means the source's markup changed, not that
the source has no events -- exactly the failure mode that made the R5 bug
invisible. main() catches ParseError and exits 1 with a clear message so a
broken parser fails loudly instead of writing a plausible-looking empty file.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from collections.abc import Callable
from typing import Any

from bs4 import BeautifulSoup, Tag


class ParseError(Exception):
    """Raised when a parser can't find its expected container elements at all.

    Distinct from "found containers, none in the target week" (a normal,
    valid empty result) -- this means the source's markup likely changed
    and the parser needs updating, not that the week is quiet.
    """


Event = dict[str, str]


def _write_event(
    title: str, venue: str, date: str, time: str, cost: str, url: str, description: str
) -> Event:
    return {
        "title": title.strip(),
        "venue": venue.strip(),
        "date": date,
        "time": time.strip(),
        "cost": cost.strip(),
        "url": url.strip(),
        "description": description.strip(),
    }


def _text(el: Tag | None) -> str:
    return el.get_text(strip=True) if el else ""


def _attr(el: Tag | None, name: str, default: str = "") -> str:
    if el is None:
        return default
    value = el.get(name, default)
    return value if isinstance(value, str) else default


# ---------------------------------------------------------------------------
# r5-productions -- WordPress "RHP" events plugin
# ---------------------------------------------------------------------------


def parse_r5_productions(html: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.rhp-event__info--list")
    if not containers:
        raise ParseError("no rhp-event__info--list blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.find_previous(id="eventDate")
        date_text = _text(date_el)
        date_match = re.search(r"(\w{3}),?\s+(\w{3})\s+(\d{1,2})", date_text)
        if not date_match:
            continue
        month = _parse_month(date_match.group(2))
        if month is None:
            continue
        try:
            event_date = datetime.date(week_start.year, month, int(date_match.group(3)))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one("#eventTitle h2, .rhp-event__title--list")
        tagline_el = container.select_one(".eventTagLine")
        title = _text(title_el)
        tagline = _text(tagline_el)
        full_title = f"{tagline} | {title}" if tagline and title else (title or tagline)
        if not full_title:
            continue

        time_el = container.select_one(".rhp-event__time-text--list")
        cost_el = container.select_one(".rhp-event__cost-text--list")
        venue_el = container.select_one(".venueLink")
        url_el = container.select_one("#eventTitle")

        events.append(
            _write_event(
                title=full_title,
                venue=_attr(venue_el, "title", _text(venue_el)),
                date=str(event_date),
                time=_text(time_el),
                cost=_text(cost_el),
                url=_attr(url_el, "href") or "https://r5productions.com/events/",
                description=tagline,
            )
        )
    return events


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _parse_month(name: str) -> int | None:
    return _MONTHS.get(name.strip().lower()[:3])


# ---------------------------------------------------------------------------
# philamoca
# ---------------------------------------------------------------------------


def parse_philamoca(html: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("a.event")
    if not containers:
        raise ParseError("no a.event blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.select_one(".event__date")
        if not date_el or not date_el.get("datetime"):
            continue
        try:
            event_date = datetime.date.fromisoformat(str(date_el["datetime"]))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one(".event__title")
        desc_el = container.select_one(".event__description")
        cost_el = container.select_one(".event__detail--tickets .event__detail-value")
        time_els = container.select(".event__detail--time time")
        times = ", ".join(f"{t.strip()}" for t in (te.get_text(strip=True) for te in time_els) if t)

        events.append(
            _write_event(
                title=_text(title_el),
                venue="PhilaMOCA, 531 N 12th St, Philadelphia, PA 19123",
                date=str(event_date),
                time=times,
                cost=_text(cost_el),
                url=_attr(container, "href") or "https://www.philamoca.org/",
                description=_text(desc_el),
            )
        )
    return events


# ---------------------------------------------------------------------------
# phillygoth.net -- WordPress "Events Manager" plugin
# ---------------------------------------------------------------------------


def parse_phillygoth(html: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.em-event.em-item")
    if not containers:
        raise ParseError("no em-event em-item blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.select_one(".em-event-date")
        date_text = _text(date_el)
        event_date = _parse_long_date(date_text, week_start.year)
        if event_date is None or not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one(".em-item-title a")
        venue_el = container.select_one(".em-event-location a")
        actions_el = container.select_one(".em-item-actions")

        events.append(
            _write_event(
                title=_text(title_el),
                venue=_text(venue_el),
                date=str(event_date),
                time="",
                cost="",
                url=_attr(title_el, "href"),
                description=_text(actions_el),
            )
        )
    return events


def _parse_long_date(text: str, default_year: int) -> datetime.date | None:
    match = re.search(r"(\w+)\s+(\d{1,2}),?\s+(\d{4})?", text)
    if not match:
        return None
    month = _parse_month(match.group(1))
    if month is None:
        return None
    year = int(match.group(3)) if match.group(3) else default_year
    try:
        return datetime.date(year, month, int(match.group(2)))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# philly-shows.com -- Webflow CMS list
# ---------------------------------------------------------------------------


def parse_philly_shows(html: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.showblock")
    if not containers:
        raise ParseError("no showblock elements found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        fields = container.select("p.showdatevenue")
        if len(fields) < 2:
            continue
        date_time_text = fields[0].get_text(strip=True)
        venue_text = fields[1].get_text(strip=True)
        date_match = re.search(r"(\w+)\s+(\d{1,2}),?\s+(\d{4})", date_time_text)
        if not date_match:
            continue
        month = _parse_month(date_match.group(1))
        if month is None:
            continue
        try:
            event_date = datetime.date(int(date_match.group(3)), month, int(date_match.group(2)))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one("h3")
        cost_el = container.select_one(".showprice")
        link_el = container.select_one("a.btn")
        time_match = re.search(r"\d{1,2}:\d{2}\s*[AP]M", date_time_text)

        events.append(
            _write_event(
                title=_text(title_el),
                venue=venue_text,
                date=str(event_date),
                time=time_match.group(0) if time_match else "",
                cost=_text(cost_el),
                url=_attr(link_el, "href") or "https://www.philly-shows.com/",
                description=_text(title_el),
            )
        )
    return events


# ---------------------------------------------------------------------------
# the-rotunda -- Squarespace-style month calendar grid
# ---------------------------------------------------------------------------


def parse_the_rotunda(
    html: str,
    week_start: datetime.date,
    week_end: datetime.date,
    *,
    context_date: datetime.date | None = None,
) -> list[Event]:
    # The calendar grid's non-"notmonth" <td> cells all belong to whichever
    # single month was requested via the fetched URL's ?date= param -- that's
    # not recoverable from the HTML alone (the page shows prev/next month
    # nav links for *all* three months, not just the current one), so the
    # caller must pass the same date it used to build the URL. Guessing this
    # from day numbers alone (e.g. "small day numbers near a month boundary
    # must be next month") is exactly the kind of fragile inference that
    # silently produces wrong dates -- require it explicitly instead.
    if context_date is None:
        raise ParseError(
            "the-rotunda parser requires --context-date (the same date used in the fetched URL's ?date= param)"
        )
    soup = BeautifulSoup(html, "html.parser")
    cells = soup.select("td:not(.notmonth)")
    if not cells:
        raise ParseError("no in-month calendar <td> cells found -- markup may have changed")

    events: list[Event] = []
    found_any_day = False
    for cell in cells:
        day_el = cell.select_one(".day")
        if not day_el or not day_el.get_text(strip=True).isdigit():
            continue
        found_any_day = True
        day = int(day_el.get_text(strip=True))
        try:
            event_date = datetime.date(context_date.year, context_date.month, day)
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        for item in cell.select("li.anEvent"):
            link = item.select_one("a")
            time_match = re.match(r"\s*([\d:]+\s*[AP]M)", item.get_text())
            events.append(
                _write_event(
                    title=_text(link),
                    venue="The Rotunda, 4014 Walnut St, Philadelphia, PA 19104",
                    date=str(event_date),
                    time=time_match.group(1) if time_match else "",
                    cost="",
                    url=("https://www.therotunda.org" + _attr(link, "href")) if link else "",
                    description=_text(link),
                )
            )
    if not found_any_day:
        raise ParseError("no calendar day cells with a .day number found -- markup may have changed")
    return events


# ---------------------------------------------------------------------------
# philly-ask-a-punk -- JSON API (Gancio)
# ---------------------------------------------------------------------------

_UTC_OFFSET_ET = -4 * 3600  # EDT; -5*3600 for EST (Nov-Mar)


def parse_philly_ask_a_punk(raw_json: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    try:
        raw_events = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response was not valid JSON: {exc}") from None
    if not isinstance(raw_events, list):
        raise ParseError("expected a JSON array of events at the top level")

    events: list[Event] = []
    for item in raw_events:
        start_ts = item.get("start_datetime")
        if start_ts is None:
            continue
        event_date = datetime.datetime.fromtimestamp(start_ts + _UTC_OFFSET_ET, tz=datetime.UTC).date()
        end_ts = item.get("end_datetime")
        if item.get("multidate") and end_ts:
            end_date = datetime.datetime.fromtimestamp(end_ts + _UTC_OFFSET_ET, tz=datetime.UTC).date()
            in_week = event_date <= week_end and end_date >= week_start
        else:
            in_week = week_start <= event_date <= week_end
        if not in_week:
            continue

        place = item.get("place") or {}
        venue_name = place.get("name", "")
        venue_address = place.get("address", "")
        venue = f"{venue_name} ({venue_address})" if venue_address else venue_name
        event_time = datetime.datetime.fromtimestamp(start_ts + _UTC_OFFSET_ET, tz=datetime.UTC).strftime("%-I:%M %p")

        events.append(
            _write_event(
                title=item.get("title", ""),
                venue=venue,
                date=str(event_date),
                time=event_time,
                cost="",
                url=f"https://philly.askapunk.net/{item.get('slug', '')}",
                description=" / ".join(item.get("tags", [])),
            )
        )
    return events


# ---------------------------------------------------------------------------
# iCal (Luma UTC-offset; Meetup TZID=America/New_York) shared parser
# ---------------------------------------------------------------------------


def _unescape_ical(text: str) -> str:
    return text.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def _unfold_ical(raw: str) -> list[str]:
    lines: list[str] = []
    for line in raw.replace("\r\n", "\n").split("\n"):
        if line.startswith(" ") and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    return lines


def _parse_ical_events(raw: str) -> list[dict[str, str]]:
    lines = _unfold_ical(raw)
    events: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in lines:
        if line.startswith("BEGIN:VEVENT"):
            current = {}
        elif line.startswith("END:VEVENT"):
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            key, _, value = line.partition(":")
            field = key.split(";")[0]
            current[field] = value
            if field == "DTSTART":
                current["DTSTART_PARAMS"] = key
    return events


def parse_luma(raw: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    # Unlike the HTML parsers, zero VEVENTs is a *valid* result for iCal --
    # an empty calendar is still well-formed iCal, and this feed's Jul 2026
    # note documents typically-15-20-events-across-4-weeks volume, so a
    # short window genuinely can be empty. Only raise if the response isn't
    # even valid iCal at all (e.g. an error page instead of a feed).
    if "BEGIN:VCALENDAR" not in raw:
        raise ParseError("response doesn't look like an iCal feed at all (no BEGIN:VCALENDAR) -- feed may have changed")
    raw_events = _parse_ical_events(raw)

    events: list[Event] = []
    for item in raw_events:
        dtstart = item.get("DTSTART", "")
        match = re.match(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?", dtstart)
        if not match:
            continue
        year, month, day, hour, minute, second = (int(g) for g in match.groups())
        utc_dt = datetime.datetime(year, month, day, hour, minute, second, tzinfo=datetime.UTC)
        local_dt = utc_dt + datetime.timedelta(seconds=_UTC_OFFSET_ET)
        event_date = local_dt.date()
        if not (week_start <= event_date <= week_end):
            continue

        location = _unescape_ical(item.get("LOCATION", ""))
        events.append(
            _write_event(
                title=_unescape_ical(item.get("SUMMARY", "")),
                venue=location if not location.startswith("http") else "(online / see description)",
                date=str(event_date),
                time=local_dt.strftime("%-I:%M %p"),
                cost="",
                url=location if location.startswith("http") else "",
                description=_unescape_ical(item.get("DESCRIPTION", "")),
            )
        )
    return events


def parse_meetup(raw: str, week_start: datetime.date, week_end: datetime.date) -> list[Event]:
    # See parse_luma's comment: zero VEVENTs is a valid result here (several
    # of these groups are genuinely quiet -- see the "Empty ... keep" status
    # notes in SKILL.md), so only raise on a response that isn't valid iCal.
    if "BEGIN:VCALENDAR" not in raw:
        raise ParseError("response doesn't look like an iCal feed at all (no BEGIN:VCALENDAR) -- feed may have changed")
    raw_events = _parse_ical_events(raw)

    events: list[Event] = []
    for item in raw_events:
        dtstart = item.get("DTSTART", "")
        match = re.match(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})", dtstart)
        if not match:
            continue
        year, month, day, hour, minute, _second = (int(g) for g in match.groups())
        try:
            event_date = datetime.date(year, month, day)
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        location = _unescape_ical(item.get("LOCATION", ""))
        is_online = (not location) or location.startswith("http")
        venue = "(online)" if is_online else location
        time_str = datetime.time(hour, minute).strftime("%-I:%M %p")

        events.append(
            _write_event(
                title=_unescape_ical(item.get("SUMMARY", "")),
                venue=venue,
                date=str(event_date),
                time=time_str,
                cost="",
                url=item.get("URL", ""),
                description=_unescape_ical(item.get("DESCRIPTION", "")),
            )
        )
    return events


_PARSERS: dict[str, Callable[..., list[Event]]] = {
    "r5-productions": parse_r5_productions,
    "philamoca": parse_philamoca,
    "phillygoth": parse_phillygoth,
    "philly-shows": parse_philly_shows,
    "the-rotunda": parse_the_rotunda,
    "philly-ask-a-punk": parse_philly_ask_a_punk,
    "luma-ical": parse_luma,
    "meetup-ical": parse_meetup,
}


def build_output(source_name: str, events: list[Event]) -> dict[str, Any]:
    return {
        "source": source_name,
        "collected_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("parser_key", choices=sorted(_PARSERS.keys()))
    parser.add_argument("--source-name", required=True, help='Value for the output JSON\'s "source" field')
    parser.add_argument("--week-start", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument("--week-end", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument(
        "--context-date",
        help="YYYY-MM-DD. Required for the-rotunda only -- the same date used in the fetched URL's ?date= param.",
    )
    args = parser.parse_args()

    week_start = datetime.date.fromisoformat(args.week_start)
    week_end = datetime.date.fromisoformat(args.week_end)
    raw = sys.stdin.read()

    kwargs: dict[str, Any] = {}
    if args.context_date:
        kwargs["context_date"] = datetime.date.fromisoformat(args.context_date)

    try:
        events = _PARSERS[args.parser_key](raw, week_start, week_end, **kwargs)
    except ParseError as exc:
        print(f"FAILED to parse ({args.parser_key}): {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(build_output(args.source_name, events), indent=2))
    # Printed to stderr, not stdout, so it doesn't corrupt the JSON when stdout
    # is redirected straight to the output file -- lets the caller (Collection)
    # read the real, just-computed count for its confirmation-turn message
    # without re-opening the file it just wrote.
    print(f"{args.source_name}: {len(events)} events parsed.", file=sys.stderr)


if __name__ == "__main__":
    main()
