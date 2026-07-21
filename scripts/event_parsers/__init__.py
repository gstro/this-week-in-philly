"""Registry of source parsers. To add a new source:

1. Add a module here implementing the EventParser protocol from .base
   (a `parse(raw, week_start, week_end, **kwargs) -> list[Event]` function).
2. Register it in PARSERS below with the CLI key used in SKILL.md's Method
   field for that source.
3. Add fixture-based tests in tests/test_parse_events.py.

Nothing outside this package needs to change -- scripts/parse_events.py's
CLI just dispatches through PARSERS.
"""

from collections.abc import Callable

from . import luma, meetup, philamoca, philly_ask_a_punk, philly_shows, phillygoth, r5_productions, the_rotunda
from .base import Event, EventParser, ParseError

# Typed as a plain Callable, not dict[str, EventParser]: mypy's structural
# matching for Protocols with **kwargs has known rough edges around plain
# functions with non-matching parameter names (each parser here uses its
# own descriptive first-param name -- html, raw_json, raw -- rather than
# EventParser's "raw"). EventParser stays the documented, canonical
# interface every module in this package implements; this loosens only the
# registry's own typing, not the contract itself.
PARSERS: dict[str, Callable[..., list[Event]]] = {
    "r5-productions": r5_productions.parse,
    "philamoca": philamoca.parse,
    "phillygoth": phillygoth.parse,
    "philly-shows": philly_shows.parse,
    "the-rotunda": the_rotunda.parse,
    "philly-ask-a-punk": philly_ask_a_punk.parse,
    "luma-ical": luma.parse,
    "meetup-ical": meetup.parse,
}

__all__ = ["PARSERS", "Event", "EventParser", "ParseError"]
