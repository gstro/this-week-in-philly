"""meetup-ical -- shared parser for all 8 Meetup group iCal feeds (TZID=America/New_York DTSTART)."""

from __future__ import annotations

import datetime
from typing import Any
import re

from . import _ical
from .base import Event, ParseError, write_event


def parse(raw: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    # See luma.py's comment: zero VEVENTs is a valid result here too --
    # several of these groups are genuinely quiet (see the "Empty ... keep"
    # status notes in philadelphia-sources/SKILL.md) -- only raise on a
    # response that isn't valid iCal at all.
    if "BEGIN:VCALENDAR" not in raw:
        raise ParseError("response doesn't look like an iCal feed at all (no BEGIN:VCALENDAR) -- feed may have changed")
    raw_events = _ical.parse_vevents(raw)

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

        location = _ical.unescape(item.get("LOCATION", ""))
        is_online = (not location) or location.startswith("http")
        venue = "(online)" if is_online else location
        time_str = datetime.time(hour, minute).strftime("%-I:%M %p")

        events.append(
            write_event(
                title=_ical.unescape(item.get("SUMMARY", "")),
                venue=venue,
                date=str(event_date),
                time=time_str,
                cost="",
                url=item.get("URL", ""),
                description=_ical.unescape(item.get("DESCRIPTION", "")),
            )
        )
    return events
