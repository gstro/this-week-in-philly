"""philly-ask-a-punk -- JSON API (Gancio federated events platform)."""

from __future__ import annotations

import datetime
import json
from typing import Any
from zoneinfo import ZoneInfo

from .base import Event, ParseError, write_event

# Was a hardcoded -4h (EDT) offset with no DST branch -- correct roughly
# March-November, silently an hour off the rest of the year. ZoneInfo
# resolves the right UTC offset for America/New_York on any given date,
# including the EDT/EST transition itself, with no manual date math.
_EASTERN = ZoneInfo("America/New_York")


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
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
        event_date = datetime.datetime.fromtimestamp(start_ts, tz=_EASTERN).date()
        end_ts = item.get("end_datetime")
        if item.get("multidate") and end_ts:
            end_date = datetime.datetime.fromtimestamp(end_ts, tz=_EASTERN).date()
            in_week = event_date <= week_end and end_date >= week_start
        else:
            in_week = week_start <= event_date <= week_end
        if not in_week:
            continue

        place = item.get("place") or {}
        venue_name = str(place.get("name") or "").strip()
        venue_address = str(place.get("address") or "").strip()
        # When the feed has no real place it sets both fields to its own name,
        # which used to render as "ask a punk (ask a punk)" and, with no
        # Selection-authored address to key on, collapsed to the degenerate
        # venue key `askapunkaskapunk` in check_selection.py. Emit the name
        # once in that case; a useless key is better than a misleading one.
        if venue_address and venue_address.casefold() != venue_name.casefold():
            venue = f"{venue_name} ({venue_address})"
        else:
            venue = venue_name
            venue_address = ""
        event_time = datetime.datetime.fromtimestamp(start_ts, tz=_EASTERN).strftime("%-I:%M %p")

        events.append(
            write_event(
                title=item.get("title", ""),
                venue=venue,
                date=str(event_date),
                time=event_time,
                cost="",
                url=f"https://philly.askapunk.net/{item.get('slug', '')}",
                description=" / ".join(item.get("tags", [])),
                venue_address=venue_address,
            )
        )
    return events
