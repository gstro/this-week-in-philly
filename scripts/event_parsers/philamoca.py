"""philamoca -- static WordPress theme with custom event__ markup."""

from __future__ import annotations

import datetime
from typing import Any

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, text, write_event


def parse(html: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select("a.event")
    if not containers:
        raise ParseError("no a.event blocks found -- markup may have changed")

    events: list[Event] = []
    for container in containers:
        date_el = container.select_one(".event__date")
        if not date_el or not date_el.get("datetime"):
            continue
        try:
            event_date = datetime.date.fromisoformat(str(date_el["datetime"]))
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title_el = container.select_one(".event__title")
        desc_el = container.select_one(".event__description")
        cost_el = container.select_one(".event__detail--tickets .event__detail-value")
        time_els = container.select(".event__detail--time time")
        times = ", ".join(t for t in (te.get_text(strip=True) for te in time_els) if t)

        events.append(
            write_event(
                title=text(title_el),
                venue="PhilaMOCA, 531 N 12th St, Philadelphia, PA 19123",
                date=str(event_date),
                time=times,
                cost=text(cost_el),
                url=attr(container, "href") or "https://www.philamoca.org/",
                description=text(desc_el),
            )
        )
    return events
