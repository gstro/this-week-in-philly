"""the-rotunda -- Squarespace-style month calendar grid.

Unlike the other HTML parsers, this one needs an explicit context_date kwarg:
the calendar grid's non-"notmonth" <td> cells all belong to whichever single
month was requested via the fetched URL's ?date= param, and that's not
recoverable from the HTML alone (the page shows prev/next-month nav links
for all three visible months, not just the current one). Guessing it from
day numbers alone (e.g. "small day numbers near a month boundary must be
next month") is exactly the kind of fragile inference that silently
produces wrong dates -- require it explicitly instead.
"""

from __future__ import annotations

import datetime
import re
from typing import Any

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, text, write_event


def parse(
    html: str,
    week_start: datetime.date,
    week_end: datetime.date,
    *,
    context_date: datetime.date | None = None,
    **_kwargs: Any,  # noqa: ANN401
) -> list[Event]:
    if context_date is None:
        raise ParseError(
            "the-rotunda parser requires --context-date (the same date used in the fetched URL's ?date= param)"
        )
    soup = BeautifulSoup(html, "html.parser")
    cells = soup.select("td:not(.notmonth)")
    if not cells:
        raise ParseError("no in-month calendar <td> cells found -- markup may have changed")

    events: list[Event] = []
    found_any_day = False
    for cell in cells:
        day_el = cell.select_one(".day")
        if not day_el or not day_el.get_text(strip=True).isdigit():
            continue
        found_any_day = True
        day = int(day_el.get_text(strip=True))
        try:
            event_date = datetime.date(context_date.year, context_date.month, day)
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        for item in cell.select("li.anEvent"):
            link = item.select_one("a")
            time_match = re.match(r"\s*([\d:]+\s*[AP]M)", item.get_text())
            events.append(
                write_event(
                    title=text(link),
                    venue="The Rotunda, 4014 Walnut St, Philadelphia, PA 19104",
                    date=str(event_date),
                    time=time_match.group(1) if time_match else "",
                    cost="",
                    url=("https://www.therotunda.org" + attr(link, "href")) if link else "",
                    description=text(link),
                )
            )
    if not found_any_day:
        raise ParseError("no calendar day cells with a .day number found -- markup may have changed")
    return events
