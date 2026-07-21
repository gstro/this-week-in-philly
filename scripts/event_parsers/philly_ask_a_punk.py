"""philly-ask-a-punk -- JSON API (Gancio federated events platform)."""

from __future__ import annotations

import datetime
from typing import Any
import json

from .base import Event, ParseError, write_event

_UTC_OFFSET_ET = -4 * 3600  # EDT; -5*3600 for EST (Nov-Mar)


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
            write_event(
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
