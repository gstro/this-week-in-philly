"""wxpn -- WXPN's concert calendar, via the Modern Tribe Events REST API on
xpn.org (`/wp-json/tribe/events/v1/events`), not the public
xpn.org/concert-and-events/ page.

The site used to be read from `backend.xpn.org/wp-json/wp/v2/event`; that
host stopped serving (its Pantheon site was removed -- the TLS certificate
no longer covers the hostname and the origin answers "404 - Unknown site"),
and the first failed run was 2026-09-28. The calendar moved to The Events
Calendar plugin on xpn.org itself, confirmed live 2026-10-18.

API quirks:

- Unlike the old endpoint, this one filters server-side: `start_date` and
  `end_date` bound the window, so the collector fetches only the target
  week. `per_page` is capped at 50 (a larger value is silently clamped), and
  the response is an object (`events`, `total`, `total_pages`), which
  collect_source.py flattens into the bare array this parser takes.
- Most events are `all_day` with a "00:00:00" start -- a date, not a
  showtime -- so time is left blank for those. A few (the Free At Noon
  series) carry a real start time, which is surfaced.
- Titles, venue names and the `website` ticket link are HTML-escaped
  ("Ortlieb&#8217;s", "&amp;" in query strings), so they're entity-decoded.
- `venue` is an object when set and an empty array when not.
- The "Philadelphia Area" category is on nearly every event, so it carries no
  signal; the remaining categories ("WXPN Welcomes", "Free At Noon", "Central
  PA") become the description.
"""

from __future__ import annotations

import datetime
import html
import json
from typing import Any

from .base import Event, ParseError, write_event

_NOISE_CATEGORY = "Philadelphia Area"


def _unescape(value: object) -> str:
    return html.unescape(str(value or ""))


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response isn't valid JSON: {exc}") from exc

    if not isinstance(payload, list):
        raise ParseError("response is not a JSON array of events -- API shape may have changed")

    events: list[Event] = []
    for item in payload:
        if not isinstance(item, dict):
            continue

        raw_start = str(item.get("start_date") or "")
        try:
            start = datetime.datetime.fromisoformat(raw_start)
        except ValueError:
            continue
        event_date = start.date()
        if not (week_start <= event_date <= week_end):
            continue

        venue = item.get("venue")
        venue_name = _unescape(venue.get("venue")) if isinstance(venue, dict) else ""
        time = "" if item.get("all_day") else start.strftime("%-I:%M %p")
        categories = [
            _unescape(c.get("name"))
            for c in item.get("categories") or []
            if isinstance(c, dict) and c.get("name") != _NOISE_CATEGORY
        ]

        events.append(
            write_event(
                title=_unescape(item.get("title")),
                venue=venue_name,
                date=str(event_date),
                time=time,
                cost=str(item.get("cost") or ""),
                url=str(item.get("url") or "") or _unescape(item.get("website")),
                description=", ".join(c for c in categories if c),
            )
        )

    return events
