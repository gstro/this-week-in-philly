"""luma-ical -- Luma's Philadelphia discover feed (UTC DTSTART)."""

from __future__ import annotations

import datetime
from typing import Any
import re

from . import _ical
from .base import Event, ParseError, write_event

_UTC_OFFSET_ET = -4 * 3600  # EDT; -5*3600 for EST (Nov-Mar)


def parse(raw: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    # Unlike the HTML parsers, zero VEVENTs is a *valid* result for iCal --
    # an empty calendar is still well-formed iCal, and this feed's typical
    # volume (15-20 events across ~4 weeks) means a short window genuinely
    # can be empty. Only raise if the response isn't even valid iCal at all
    # (e.g. an error page instead of a feed).
    if "BEGIN:VCALENDAR" not in raw:
        raise ParseError("response doesn't look like an iCal feed at all (no BEGIN:VCALENDAR) -- feed may have changed")
    raw_events = _ical.parse_vevents(raw)

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

        location = _ical.unescape(item.get("LOCATION", ""))
        events.append(
            write_event(
                title=_ical.unescape(item.get("SUMMARY", "")),
                venue=location if not location.startswith("http") else "(online / see description)",
                date=str(event_date),
                time=local_dt.strftime("%-I:%M %p"),
                cost="",
                url=location if location.startswith("http") else "",
                description=_ical.unescape(item.get("DESCRIPTION", "")),
            )
        )
    return events
