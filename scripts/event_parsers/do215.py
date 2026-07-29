"""do215 -- Do215.com's undocumented day-page JSON API.

Not the site's HTML at all: `https://do215.com/events/YYYY/M/D.json` (no
zero-padding on month/day) returns `{"events": [...], "paging": {...}}`,
confirmed live 2026-07-29. Replaces a model-reads-fetch_page_text.py
approach that needed one Chromium page load per day (7 for a week) and,
under budget pressure, was one of several sources observed writing a
plausible-looking empty file instead of running the documented fetch at
all -- see scripts/check_yield.py's module docstring.

Two API quirks this parser exists specifically to handle:

- `begin_time` carries the wrong UTC offset (confirmed -05:00 in August, when
  Philadelphia is on -04:00 EDT); `tz_adjusted_begin_date` has the correct
  one. Always use the latter for both date and time.
- Day pages inject stale "featured" events from unrelated dates (observed:
  a June listing bleeding into an August day page) -- the URL's day is not
  reliable, so every event is filtered on its own `tz_adjusted_begin_date`,
  never on which day-page it came from.

`is_ongoing: true` marks recurring "every day"-style listings, which the
source's own prior model-driven instructions already filtered out by hand;
this parser drops them the same way, deterministically.

collect_source.py owns the multi-day, multi-page fetch loop and hands this
parser one merged `{"events": [...]}` blob (each day/page response has the
identical shape, so concatenating their `events` lists before parsing is
safe) -- this function itself makes no network calls and stays a pure
transform, consistent with every other module in this package.
"""

from __future__ import annotations

import datetime
import json
from typing import Any

from .base import Event, ParseError, write_event


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response isn't valid JSON: {exc}") from exc

    if not isinstance(payload, dict) or "events" not in payload:
        raise ParseError("response has no top-level 'events' key -- API shape may have changed")

    raw_events = payload["events"]
    if not isinstance(raw_events, list):
        raise ParseError("'events' is not a list -- API shape may have changed")

    events: list[Event] = []
    seen_ids: set[Any] = set()
    for item in raw_events:
        if not isinstance(item, dict):
            continue

        event_id = item.get("id")
        if event_id is not None:
            if event_id in seen_ids:
                # Stale "featured" entries can appear on more than one day's page.
                continue
            seen_ids.add(event_id)

        if item.get("is_ongoing"):
            continue

        adjusted = item.get("tz_adjusted_begin_date")
        if not adjusted:
            continue
        try:
            start = datetime.datetime.fromisoformat(adjusted)
        except ValueError:
            continue
        event_date = start.date()
        if not (week_start <= event_date <= week_end):
            continue

        venue = item.get("venue") or {}
        venue_title = str(venue.get("title", "")).strip()
        city = venue.get("city")
        state = venue.get("state")
        if city and state:
            venue_str = f"{venue_title}, {city}, {state}"
        elif city:
            venue_str = f"{venue_title}, {city}"
        else:
            venue_str = venue_title

        if item.get("is_free"):
            cost = "Free"
        else:
            cost = str(item.get("ticket_info") or "").strip()

        permalink = str(item.get("permalink", ""))
        url = f"https://do215.com{permalink}" if permalink else ""

        events.append(
            write_event(
                title=str(item.get("title", "")),
                venue=venue_str,
                date=str(event_date),
                time=start.strftime("%-I:%M %p"),
                cost=cost,
                url=url,
                description=str(item.get("excerpt") or ""),
            )
        )

    return events
