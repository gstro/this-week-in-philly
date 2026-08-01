"""phillygoth.net -- WordPress "Events Manager" plugin."""

from __future__ import annotations

import datetime
import re
from typing import Any

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, parse_month, resolve_year, text, write_event


def parse(html: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.em-event.em-item")
    if not containers:
        raise ParseError("no em-event em-item blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.select_one(".em-event-date")
        date_text = text(date_el)
        event_date = _parse_long_date(date_text, week_start)
        if event_date is None or not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one(".em-item-title a")
        venue_el = container.select_one(".em-event-location a")
        actions_el = container.select_one(".em-item-actions")

        events.append(
            write_event(
                title=text(title_el),
                venue=text(venue_el),
                date=str(event_date),
                time="",
                cost="",
                url=attr(title_el, "href"),
                description=text(actions_el),
            )
        )
    return events


def _parse_long_date(date_text: str, week_start: datetime.date) -> datetime.date | None:
    # \s* (not \s+) before the optional year group: BeautifulSoup's
    # get_text(strip=True) removes trailing whitespace, so a genuinely
    # year-less date ("January 1", nothing after) would never match at all
    # under a mandatory \s+ -- silently skipping every such event rather
    # than falling through to resolve_year below.
    match = re.search(r"(\w+)\s+(\d{1,2}),?\s*(\d{4})?", date_text)
    if not match:
        return None
    month = parse_month(match.group(1))
    if month is None:
        return None
    day = int(match.group(2))
    if match.group(3):
        # The page did give an explicit year -- trust it, no resolution needed.
        try:
            return datetime.date(int(match.group(3)), month, day)
        except ValueError:
            return None
    year = resolve_year(month, day, week_start)
    if year is None:
        return None
    return datetime.date(year, month, day)  # already validated by resolve_year
