"""cinespeak -- server-rendered WordPress block markup (`/cinema/`).

Previously documented in philadelphia-sources/SKILL.md as having "no stable
structure" and left to manual/model reading -- confirmed live 2026-07-29
that's no longer true (or wasn't ever quite true): the page is a plain
Gutenberg block listing, one `li.wp-block-post.event` per screening, with a
consistent internal shape:

- title + ticket URL: the `.wp-block-post-title a` link
  (cinespeak.eventive.org)
- date/time: a single `p.wp-block-paragraph`, formatted like
  "July 30, 2026   @ 7:45  pm" -- irregular whitespace around "@ ", handled
  with a permissive regex rather than a fixed-width split
- venue: NOT in a dedicated venue element -- it's the second
  `.wp-block-buttons` block's link (the first is always "Buy Tickets",
  pointing to eventive.org; the second points to a Google Maps link and its
  text is the venue name). Distinguishing them by link target (maps.app.goo.gl
  / google.com/maps) rather than position, in case a listing without a ticket
  button ever appears.
- tag/category (e.g. "Documentary Feature", "LGBTQIA+"): optional,
  `.wp-block-post-terms a` -- not every event has one
"""

from __future__ import annotations

import datetime
import re
from typing import Any

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, parse_month, text, write_event

_DATE_RE = re.compile(
    r"([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)",
    re.IGNORECASE,
)


def parse(html: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("li.wp-block-post.event")
    if not containers:
        raise ParseError("no li.wp-block-post.event blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.select_one("p.wp-block-paragraph")
        match = _DATE_RE.search(text(date_el))
        if not match:
            continue
        month_name, day, year, hour, minute, meridiem = match.groups()
        month = parse_month(month_name)
        if month is None:
            continue
        try:
            event_date = datetime.date(int(year), month, int(day))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        hour_int = int(hour) % 12
        if meridiem.lower() == "pm":
            hour_int += 12
        event_time = datetime.time(hour_int, int(minute)).strftime("%-I:%M %p")

        title_el = container.select_one(".wp-block-post-title a")

        venue = ""
        for button_link in container.select(".wp-block-buttons a"):
            href = attr(button_link, "href")
            if "maps.app.goo.gl" in href or "google.com/maps" in href:
                venue = text(button_link)
                break

        tag_el = container.select_one(".wp-block-post-terms a")
        description = text(tag_el)

        events.append(
            write_event(
                title=text(title_el),
                venue=venue,
                date=str(event_date),
                time=event_time,
                cost="",
                url=attr(title_el, "href") or "https://cinespeak.org/cinema/",
                description=description,
            )
        )
    return events
