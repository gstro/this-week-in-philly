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


def write_event(
    title: str,
    venue: str,
    date: str,
    time: str,
    cost: str,
    url: str,
    description: str,
    *,
    venue_address: str = "",
    venue_id: str = "",
) -> Event:
    """The seven positional fields are the contract every parser writes.

    `venue_address` and `venue_id` are optional structured venue data, for the
    few sources whose upstream actually supplies it (do215's venue object,
    philly_ask_a_punk's `place`). They are **omitted from the returned dict
    when empty** rather than written as "" -- adding two always-present keys
    would change the output shape of all ~20 parsers and churn every exact-dict
    assertion in tests/test_parse_events.py to record that a source has no
    venue metadata, which is the normal case and not worth stating.

    Keyword-only so no existing parser call site changes, and `str` (not int)
    for `venue_id` to keep `Event = dict[str, str]` -- same reasoning as
    assign_ids' string candidate ids in prepare_selection_input.py.

    Consumer: merge_selections.py, which reads these off the monolithic
    _candidates.json to fill a pick's `address` when Selection didn't author
    one and to compare against it when Selection did. Deliberately NOT visible
    to Selection itself -- prepare_selection_input.py's split_by_day() strips
    both from the per-day payloads, which are Selection's only input.
    """
    event = {
        "title": title.strip(),
        "venue": venue.strip(),
        "date": date,
        "time": time.strip(),
        "cost": cost.strip(),
        "url": url.strip(),
        "description": description.strip(),
    }
    if venue_address.strip():
        event["venue_address"] = venue_address.strip()
    if venue_id.strip():
        event["venue_id"] = venue_id.strip()
    return event


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


def resolve_year(month: int, day: int, week_start: datetime.date) -> int | None:
    """Picks whichever nearby year makes (month, day) land closest to
    week_start, for sources whose date text carries no year at all.

    Naively assuming `week_start.year` (what r5_productions.py and
    phillygoth.py both did before this existed) breaks specifically when a
    target week spans a Dec/Jan boundary: week_start=2026-12-28 with a
    source date of "Jan 3" should resolve to 2027, not 2026 -- assuming
    2026 either lands the event a year in the past or drops it from the
    week-window filter entirely, silently.

    Tries week_start's year and both neighbors, so the boundary case is
    covered without a magic-number day threshold. Returns None only if
    (month, day) isn't a valid date in any of the three candidate years
    (e.g. Feb 29 outside a leap year).
    """
    candidates = []
    for year in (week_start.year - 1, week_start.year, week_start.year + 1):
        try:
            candidates.append(datetime.date(year, month, day))
        except ValueError:
            continue
    if not candidates:
        return None
    closest = min(candidates, key=lambda d: abs((d - week_start).days))
    return closest.year
