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

`venue` is a full object, not a string -- confirmed live 2026-08-30:

    {"id": 511812, "title": "Nikki Lopez", "permalink": "/venues/nikki-lopez",
     "address": "304 South St, Philadelphia, PA 19147", "city": "Philadelphia",
     "state": "PA", "zip": "19147", "latitude": null, "capacity": false}

Every prior estimate in this repo assumed it carried only {title, city, state}
-- the only copy of the payload here was a trimmed fixture -- and that
assumption is why venue identity was deferred three times as unaffordable. It
isn't: `id` is always present and is address-stable (0 of 145 ids varied across
one real week), and `address` is present for ~78% of venues. See _venue_address
for the shape hazards (`null`, "", padded, ALL-CAPS, doubled `full_address`).

What the object does NOT carry is any quality signal: `latitude` was null on
145/145 venues, `capacity` false on 145/145, `popularity` 1.0 on 142/145. There
is no API-side marker separating a genuinely bad title from an unusual-sounding
real one -- venue 511812's "Nikki Lopez" reads like a person's name but is a
real DIY venue at 304 South St (it's appeared as a plain venue name in this
project's own real weekly reports since 2026-06-10, per
docs/v1/Data/event-picks-log.csv), which is exactly why titles are appended to
rather than classified or replaced (see parse).

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
import re
from typing import Any

from .base import Event, ParseError, write_event


def _venue_address(venue: dict[str, Any]) -> str:
    """A single display-and-key-ready street address from the venue object, or "".

    The API's `address` is inconsistent: absent entirely, `null` (venue 502134,
    Spruce Street Harbor), the empty string (510458), bare street with no
    locality ("1200 Callowhill St"), already locality-bearing ("304 South St,
    Philadelphia, PA 19147"), space-padded, or ALL-CAPS. `city`/`state`/`zip`
    are separate fields and are usually present even when `address` is not.

    So: use `address` as-is when it already carries locality, otherwise append
    whichever of city/state/zip exist. Deliberately NOT `full_address`, which
    doubles the locality when `address` already has it -- venue 511812's is
    "304 South St, Philadelphia, PA 19147, Philadelphia, PA, 19147".

    Composing locality in (rather than emitting a bare street) matters
    downstream: check_selection.py's check_outside_philadelphia() skips
    address-less picks on purpose to avoid guessing, and feeding it bare
    streets would turn those deliberate skips into false warnings.
    """
    raw = str(venue.get("address") or "").strip()
    if not raw:
        return ""
    zip_code = str(venue.get("zip") or "").strip()
    state = str(venue.get("state") or "").strip()
    city = str(venue.get("city") or "").strip()
    has_locality = bool(zip_code and zip_code in raw) or bool(
        state and re.search(rf"\b{re.escape(state)}\b", raw, re.IGNORECASE)
    )
    if has_locality:
        return raw
    tail = ", ".join(part for part in (city, f"{state} {zip_code}".strip()) if part)
    return f"{raw}, {tail}" if tail else raw


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
        venue_address = _venue_address(venue)
        if venue_address:
            # Append the address rather than replace the title. Some Do215
            # titles read as odd or ambiguous out of context -- venue 511812 is
            # titled "Nikki Lopez" and covers six unrelated shows at 304 South
            # St -- but that is a real, distinctively-named DIY venue, not a
            # data defect: it's appeared as a plain venue name in this
            # project's own real weekly reports since 2026-06-10 with no
            # confusion, the same category as "Johnny Brenda's" or "Ortlieb's".
            #
            # There is no test that reliably tells an unusually-named real
            # venue apart from an actually bad title: the API carries no
            # quality signal (latitude null and capacity false on all 145
            # venues of one real week, popularity 1.0 on 142), and a lexical
            # "looks like a person's name" rule fires on 57 of 312 real venue
            # strings, including "Nikki Lopez" itself and Spruce Street Harbor.
            # A classifier tuned to catch junk would just as often mangle a
            # real venue's name.
            #
            # Preferring the address over the title outright is worse still --
            # it would erase real, recognizable names (City Winery, Union
            # Transfer, Johnny Brenda's, Underground Arts) on every record that
            # happens to carry an address. Appending is the only move that
            # cannot make a card worse: at most it is occasionally redundant.
            #
            # Skip the prepend when the address just restates the title --
            # some records set both to the same string (venue 514514, "Upper
            # Merion Township Building Park"), which would otherwise render
            # the name twice.
            if not venue_title or venue_address.casefold().startswith(venue_title.casefold()):
                venue_str = venue_address
            else:
                venue_str = f"{venue_title}, {venue_address}"
        else:
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
                venue_address=venue_address,
                venue_id=str(venue.get("id") or ""),
            )
        )

    return events
