"""r5-productions -- WordPress "RHP" events plugin."""

from __future__ import annotations

import datetime
from typing import Any
import re

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, parse_month, text, write_event


def parse(html: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("div.rhp-event__info--list")
    if not containers:
        raise ParseError("no rhp-event__info--list blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.find_previous(id="eventDate")
        date_text = text(date_el)
        date_match = re.search(r"(\w{3}),?\s+(\w{3})\s+(\d{1,2})", date_text)
        if not date_match:
            continue
        month = parse_month(date_match.group(2))
        if month is None:
            continue
        try:
            event_date = datetime.date(week_start.year, month, int(date_match.group(3)))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one("#eventTitle h2, .rhp-event__title--list")
        tagline_el = container.select_one(".eventTagLine")
        title = text(title_el)
        tagline = text(tagline_el)
        full_title = f"{tagline} | {title}" if tagline and title else (title or tagline)
        if not full_title:
            continue

        time_el = container.select_one(".rhp-event__time-text--list")
        cost_el = container.select_one(".rhp-event__cost-text--list")
        venue_el = container.select_one(".venueLink")
        url_el = container.select_one("#eventTitle")

        events.append(
            write_event(
                title=full_title,
                venue=attr(venue_el, "title", text(venue_el)),
                date=str(event_date),
                time=text(time_el),
                cost=text(cost_el),
                url=attr(url_el, "href") or "https://r5productions.com/events/",
                description=tagline,
            )
        )
    return events
