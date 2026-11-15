"""meetup-ical -- shared parser for all 8 Meetup group iCal feeds (TZID=America/New_York DTSTART).

Meetup's iCal feeds no longer carry a LOCATION for (as of 2026-11-15) any
event -- in-person or not -- so an empty LOCATION says nothing about whether
an event is online. It is reported as NO_VENUE, not "(online)" (the old
behaviour, which labelled Claude Code Philly and TERROR TELE-THON online
though both have real venues). "(online)" is kept only for a URL LOCATION.
`enrich_venues` then looks each NO_VENUE event up on its Meetup page, which
embeds the venue (and eventType) in its Next.js Apollo state.
"""

from __future__ import annotations

import datetime
import json
import re
from collections.abc import Callable
from typing import Any

from . import _ical
from .base import Event, ParseError, write_event

NO_VENUE = "(venue not listed)"
ONLINE = "(online)"


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
        if not location:
            venue = NO_VENUE
        elif location.startswith("http"):
            venue = ONLINE
        else:
            venue = location
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


_EVENT_ID = re.compile(r"/events/(\d+)")
_NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL)


def venue_from_event_page(html: str, event_url: str) -> tuple[str, str] | None:
    """(venue, address) from a Meetup event page, ("(online)", "") for an
    online event, or None when the page doesn't say. `venue` is "name, address"
    to match the shape of an iCal LOCATION. Reads only this event's own
    `Event:<id>` entry, not other events the page embeds (a recurring series)."""
    id_match = _EVENT_ID.search(event_url)
    data = _NEXT_DATA.search(html)
    if not id_match or not data:
        return None
    try:
        state = json.loads(data.group(1))["props"]["pageProps"]["__APOLLO_STATE__"]
        event = state[f"Event:{id_match.group(1)}"]
    except (KeyError, TypeError, ValueError):
        return None
    if event.get("eventType") == "ONLINE":
        return ONLINE, ""
    ref = (event.get("venue") or {}).get("__ref")
    venue = state.get(ref) if isinstance(ref, str) else None
    if not isinstance(venue, dict) or not venue.get("name"):
        return None
    name, address = str(venue["name"]), str(venue.get("address") or "")
    return (f"{name}, {address}" if address else name), address


def enrich_venues(events: list[Event], fetch_page: Callable[[str], str]) -> list[str]:
    """Replaces NO_VENUE on each event, in place, from its Meetup page.
    A page that can't be fetched or doesn't say leaves NO_VENUE (honest
    "unknown"); returns one reason per failed fetch for the manifest note."""
    failed: list[str] = []
    for event in events:
        if event["venue"] != NO_VENUE or not event["url"]:
            continue
        try:
            found = venue_from_event_page(fetch_page(event["url"]), event["url"])
        except Exception as exc:  # noqa: BLE001 -- one bad page must not lose the source
            failed.append(f"{event['url']} ({type(exc).__name__})")
            continue
        if found:
            event["venue"], address = found
            if address:
                event["venue_address"] = address
    return failed
