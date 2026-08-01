"""philadelphia-film-society -- Fandango's rendered showtime text for PFS's
3 venues (Film Society Center, Bourse Theater, East Theater).

Fandango's theater page has no server-rendered showtime data at all (no
JSON-LD `ScreeningEvent`, nothing in the raw HTML -- confirmed live
2026-08-01) and Agile Ticketing, the actual backend Fandango's own JSON-LD
names for these venues, is Incapsula-WAF-blocked domain-wide (confirmed live
2026-08-01, same shape of block as filmadelphia.org's own WAF). A real
browser is unavoidable for this source. But `fetch_page_text.py`'s rendered
text turns out to be cleanly, consistently structured per film, confirmed
against all 3 venues' real pages:

    [Title]

    Rated:
    [Rating]
    Runtime:
    [X hr Y min]

    Standard
    [Format label]
    [time1]
    [time2]
    ...

This module only ever receives already-rendered text (produced by
collect_source.py's collector, which owns the actual browser fetches) --
it's a pure text -> Event transform, like every other module in this
package, even though its input came from a browser rather than a plain
HTTP GET.

The venue name/address is NOT extracted from the rendered text (Fandango's
own theater-name header could be parsed, but the collector already knows
which of exactly 3 known venues it's fetching -- simpler and more reliable
to have it attach that directly to each entry than to re-derive it from
page text that has nothing to do with the venue's real address).
"""

from __future__ import annotations

import datetime
import json
import re
from typing import Any

from .base import Event, ParseError, write_event

_FILM_RE = re.compile(
    r"(?P<title>[^\n]+)\n\nRated:\n(?P<rating>[^\n]*)\nRuntime:\n(?P<runtime>[^\n]+)\n\n"
    r"(?P<rest>.*?)(?=\n[^\n]+\n\nRated:\n|\nNEARBY THEATERS|\Z)",
    re.DOTALL,
)
_TIME_RE = re.compile(r"\b(\d{1,2}):(\d{2})([ap])\b")


def _format_time(hour: str, minute: str, meridiem: str) -> str:
    hour_int = int(hour) % 12
    if meridiem == "p":
        hour_int += 12
    return datetime.time(hour_int, int(minute)).strftime("%-I:%M %p")


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    try:
        entries = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response isn't valid JSON: {exc}") from exc
    if not isinstance(entries, list):
        raise ParseError("response is not a JSON array of per-venue-per-day entries -- collector output shape may have changed")

    events: list[Event] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        rendered_text = entry.get("rendered_text")
        if not rendered_text:
            continue  # that fetch failed -- collect_source.py already records it in failed_requests

        context_date_str = entry.get("context_date")
        if not context_date_str:
            continue
        try:
            context_date = datetime.date.fromisoformat(context_date_str)
        except ValueError:
            continue
        if not (week_start <= context_date <= week_end):
            continue

        venue_name = str(entry.get("venue_name", ""))
        venue_address = str(entry.get("venue_address", ""))
        venue = f"{venue_name}, {venue_address}" if venue_address else venue_name
        theater_url = str(entry.get("theater_url", ""))

        for film_match in _FILM_RE.finditer(rendered_text):
            times = _TIME_RE.findall(film_match.group("rest"))
            if not times:
                continue
            time_strs = [_format_time(h, m, meridiem) for h, m, meridiem in times]
            # Preserve order, drop exact duplicates (a film occasionally repeats
            # a showtime under more than one screen format, e.g. Standard + 35mm).
            time_strs = list(dict.fromkeys(time_strs))

            rating = film_match.group("rating").strip() or "Not Rated"
            runtime = film_match.group("runtime").strip()

            events.append(
                write_event(
                    title=film_match.group("title").strip(),
                    venue=venue,
                    date=str(context_date),
                    time=", ".join(time_strs),
                    cost="",
                    url=theater_url,
                    description=f"Rated {rating}. Runtime: {runtime}.",
                )
            )

    return events
