"""wxpn -- WXPN's own WordPress REST API (backend.xpn.org), not the public
xpn.org/concert-and-events/ page.

That public page is Next.js RSC (`self.__next_f` payload chunks) with zero
event data in its raw HTML -- confirmed live 2026-07-29 -- which is why this
source needed a full Chromium render (`fetch_page_text.py`) before. The
site's own JS bundle calls `https://backend.xpn.org/wp-json/wp/v2/event`
directly; that endpoint is public, paginated, and returns structured JSON
with no model in the loop.

Two API quirks:

- `per_page` is capped at 100 (a value above that 400s), and results are
  sorted by WordPress publish date, not the event's own date -- an event in
  next week's window could be on any page. There is no server-side way to
  sort or filter by the ACF event date, so collect_source.py's collector
  fetches every page (bounded by `X-WP-Total-Pages`, capped defensively)
  and this parser filters client-side on `acf.date`.
- `acf.date` is a full "YYYY-MM-DD HH:MM:SS" string, but the time portion is
  always "00:00:00" in every record observed (2026-07-29) -- not a real
  showtime, just a date. Time is left blank rather than reporting a fake
  midnight start.
"""

from __future__ import annotations

import datetime
import html
import json
from typing import Any

from .base import Event, ParseError, write_event


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response isn't valid JSON: {exc}") from exc

    if not isinstance(payload, list):
        raise ParseError("response is not a JSON array of posts -- API shape may have changed")

    events: list[Event] = []
    for item in payload:
        if not isinstance(item, dict):
            continue

        acf = item.get("acf") or {}
        raw_date = acf.get("date")
        if not raw_date:
            continue
        date_part = str(raw_date)[:10]
        try:
            event_date = datetime.date.fromisoformat(date_part)
        except ValueError:
            continue
        if not (week_start <= event_date <= week_end):
            continue

        title = html.unescape(str(item.get("title", {}).get("rendered", "")))
        venue = html.unescape(str(acf.get("venue") or ""))
        artist = acf.get("external_artist") or ""
        description = html.unescape(str(artist)) if artist else ""

        events.append(
            write_event(
                title=title,
                venue=venue,
                date=str(event_date),
                time="",
                cost=str(acf.get("price") or ""),
                url=str(item.get("link") or acf.get("external_link") or ""),
                description=description,
            )
        )

    return events
