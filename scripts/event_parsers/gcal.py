"""gcal -- Google Calendar API event resources into the Collection schema.

Covers the three venue calendars in philadelphia-sources/SKILL.md's Google
Calendar table (Iffy Books, Wooden Shoe Books, Trakt.tv film releases).

Exists because of a real, silent data-loss incident. On 2026-08-01 the
Collection Routine improvised a one-off script to convert `gcal_list_events`
MCP responses into source JSON, and that script dropped the `url` field on
every event it wrote -- all 15 events across the three calendars came out
with `"url": ""`, where the pre-existing baseline (git 728633b) had real
URLs. Nothing caught it: the events were otherwise well-formed, the counts
were right, and check_yield.py's floors are count-based. Same shape as the
R5 Productions incident that motivated parse_events.py in the first place --
an unreviewed, untested transformation failing quietly. This module is the
tested replacement, and `url` is asserted in tests/test_parse_events.py.

Google returns two shapes for `start`/`end`, and both occur in these
calendars: `dateTime` (a timed event, RFC3339 with offset) and `date` (an
all-day event, bare YYYY-MM-DD). Trakt.tv film releases are all-day; Iffy
Books and Wooden Shoe are timed. All-day events get an empty `time` rather
than a fabricated midnight -- the same choice wxpn.py makes for its
date-only field.
"""

from __future__ import annotations

import datetime
import json
from typing import Any

from .base import Event, ParseError, write_event


def _parse_start(start: dict[str, Any]) -> tuple[datetime.date, str] | None:
    """Returns (date, display_time). display_time is "" for all-day events."""
    if "dateTime" in start:
        try:
            dt = datetime.datetime.fromisoformat(start["dateTime"])
        except (ValueError, TypeError):
            return None
        return dt.date(), dt.strftime("%-I:%M %p")
    if "date" in start:
        try:
            return datetime.date.fromisoformat(start["date"]), ""
        except (ValueError, TypeError):
            return None
    return None


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response isn't valid JSON: {exc}") from exc

    if not isinstance(payload, dict) or "items" not in payload:
        raise ParseError("response has no top-level 'items' key -- Calendar API shape may have changed")
    items = payload["items"]
    if not isinstance(items, list):
        raise ParseError("'items' is not a list -- Calendar API shape may have changed")

    # The collector supplies these; they describe the calendar as a whole, not
    # any single event (the API's own event resources carry neither).
    default_venue = str(payload.get("venue") or "")
    fallback_url = str(payload.get("fallback_url") or "")

    events: list[Event] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("status") == "cancelled":
            continue

        parsed = _parse_start(item.get("start") or {})
        if parsed is None:
            continue
        event_date, event_time = parsed
        if not (week_start <= event_date <= week_end):
            continue

        # htmlLink is the event's own Google Calendar page and is present on
        # every real event resource; fall back to the venue's site so `url` is
        # never silently empty -- the exact regression this module guards.
        url = str(item.get("htmlLink") or fallback_url)

        events.append(
            write_event(
                title=str(item.get("summary") or ""),
                venue=str(item.get("location") or default_venue),
                date=str(event_date),
                time=event_time,
                cost="",
                url=url,
                description=str(item.get("description") or ""),
            )
        )

    return events
