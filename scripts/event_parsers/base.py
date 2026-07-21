"""Shared interface and helpers for all event parsers.

Every parser module in this package exposes one function matching the
EventParser protocol below: (raw content, week_start, week_end, **kwargs) ->
list[Event]. Adding a new source means adding a new module here that
implements this signature and registering it in event_parsers/__init__.py --
nothing else in this package needs to change.
"""

from __future__ import annotations

import datetime
from typing import Any, Protocol

from bs4.element import Tag

Event = dict[str, str]


class ParseError(Exception):
    """Raised when a parser can't find its expected container elements at all.

    Distinct from "found containers, none in the target week" (a normal,
    valid empty result) -- this means the source's markup likely changed
    and the parser needs updating, not that the week is quiet. See the
    package docstring in scripts/parse_events.py for the incident (R5
    Productions silently writing 0 events) this distinction guards against.
    """


class EventParser(Protocol):
    # **kwargs is deliberately Any: this protocol covers every parser, and
    # the one existing parser-specific option (the-rotunda's context_date)
    # isn't shared by the others -- a precise union would grow with every
    # new per-parser kwarg. Each parser still declares its own precise
    # keyword-only params (see the_rotunda.py) checked at its own call site.
    def __call__(
        self,
        raw: str,
        week_start: datetime.date,
        week_end: datetime.date,
        **kwargs: Any,  # noqa: ANN401
    ) -> list[Event]: ...


def write_event(title: str, venue: str, date: str, time: str, cost: str, url: str, description: str) -> Event:
    return {
        "title": title.strip(),
        "venue": venue.strip(),
        "date": date,
        "time": time.strip(),
        "cost": cost.strip(),
        "url": url.strip(),
        "description": description.strip(),
    }


def text(el: Tag | None) -> str:
    return el.get_text(strip=True) if el else ""


def attr(el: Tag | None, name: str, default: str = "") -> str:
    if el is None:
        return default
    value = el.get(name, default)
    return value if isinstance(value, str) else default


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def parse_month(name: str) -> int | None:
    return _MONTHS.get(name.strip().lower()[:3])
