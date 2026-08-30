"""philly-shows.com -- Webflow CMS list."""

from __future__ import annotations

import datetime
import re
from typing import Any

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, parse_month, text, write_event


def parse(html: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.showblock")
    if not containers:
        # As of 2026-08-30 the site's Webflow CMS collection renders zero
        # items with its own confirmed-empty marker (`<div class="w-dyn-empty">
        # <div>No items found.</div></div>`) rather than any `div.showblock`
        # -- a real change from the markup this parser was written against
        # (div.showblock/p.showdatevenue are absent from the page entirely
        # now, not just empty). Treated as a genuine zero, matching this
        # source's documented min_expected of 0, rather than raised as a
        # structural break -- the site is telling us its own list is empty,
        # which is different from "we don't recognize this page at all."
        # NOTE: no populated example of the new markup has been observed
        # since this change. If items ever appear again, confirm the new
        # item-template selector before trusting this parser's output --
        # it currently only knows how to recognize "empty."
        if soup.select_one("div.w-dyn-empty"):
            return []
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
