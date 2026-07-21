"""philly-shows.com -- Webflow CMS list."""

from __future__ import annotations

import datetime
from typing import Any
import re

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, parse_month, text, write_event


def parse(html: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.showblock")
    if not containers:
        raise ParseError("no showblock elements found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        fields = container.select("p.showdatevenue")
        if len(fields) < 2:
            continue
        date_time_text = fields[0].get_text(strip=True)
        venue_text = fields[1].get_text(strip=True)
        date_match = re.search(r"(\w+)\s+(\d{1,2}),?\s+(\d{4})", date_time_text)
        if not date_match:
            continue
        month = parse_month(date_match.group(1))
        if month is None:
            continue
        try:
            event_date = datetime.date(int(date_match.group(3)), month, int(date_match.group(2)))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one("h3")
        cost_el = container.select_one(".showprice")
        link_el = container.select_one("a.btn")
        time_match = re.search(r"\d{1,2}:\d{2}\s*[AP]M", date_time_text)

        events.append(
            write_event(
                title=text(title_el),
                venue=venue_text,
                date=str(event_date),
                time=time_match.group(0) if time_match else "",
                cost=text(cost_el),
                url=attr(link_el, "href") or "https://www.philly-shows.com/",
                description=text(title_el),
            )
        )
    return events
