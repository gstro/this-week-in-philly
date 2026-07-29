"""lightbox-film-center -- two-stage source: a Wix-rendered homepage index,
then one JSON-LD `Event` block per detail page.

Wix's own generated class names are hashed and unstable between builds, but
its widgets carry a separate, stable `data-hook` attribute contract --
`[data-hook="events-card"]` (one per upcoming screening), `[data-hook="title"]`
(the card's own `<a>`, so its `href` is the detail page URL directly -- no
separate title-vs-link element to reconcile). Confirmed live 2026-07-29.

The homepage index only gives a short, year-less date ("Wed, Jul 29") and a
bare venue name -- not enough to filter or place on a calendar reliably. Each
event's own detail page carries a complete, authoritative `application/ld+json`
`Event` block instead (`startDate` with year and offset, full street
`location.address`), so this parser trusts the detail page entirely for
filtering and field values; the index is only used to enumerate which detail
pages exist. The homepage typically lists a small, bounded number of upcoming
events (6, observed 2026-07-29), so collect_source.py's collector fetches
every listed detail page rather than needing to pre-filter by the imprecise
index date.

A missing or unreachable detail page is not fatal to the whole source: Wix
returns 200 with its SPA shell even for a URL that doesn't resolve to a real
event (confirmed live), so a broken detail fetch just means no JSON-LD Event
block is found for that one candidate -- skipped, not raised.

One more real quirk: the page template HTML-escapes the JSON-LD payload
before embedding it, so decoded JSON string values (`name`, `description`)
still contain literal `&amp;`-style entities and need `html.unescape()` on
top of `json.loads()`.
"""

from __future__ import annotations

import datetime
import html
import json
from typing import Any

from bs4 import BeautifulSoup

from .base import Event, ParseError, attr, text, write_event


def parse_index(page_html: str) -> list[dict[str, str]]:
    """Pure HTML -> candidate list. Raises ParseError if the homepage's own
    markup doesn't have the expected events-card structure at all."""
    soup = BeautifulSoup(page_html, "html.parser")
    cards = soup.select('[data-hook="events-card"]')
    if not cards:
        raise ParseError('no [data-hook="events-card"] blocks found -- markup may have changed')

    candidates = []
    for card in cards:
        title_el = card.select_one('[data-hook="title"]')
        href = attr(title_el, "href")
        if not href:
            continue
        candidates.append({"title": text(title_el), "href": href})
    return candidates


def _extract_jsonld_event(detail_html: str) -> dict[str, Any] | None:
    soup = BeautifulSoup(detail_html, "html.parser")
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            payload = json.loads(script.get_text())
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("@type") == "Event":
            return payload
    return None


def parse(raw_json: str, week_start: datetime.date, week_end: datetime.date, **_kwargs: Any) -> list[Event]:  # noqa: ANN401
    try:
        candidates = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ParseError(f"response isn't valid JSON: {exc}") from exc
    if not isinstance(candidates, list):
        raise ParseError("response is not a JSON array of candidates -- collector output shape may have changed")

    events: list[Event] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        detail_html = candidate.get("detail_html")
        if not detail_html:
            continue
        ld_event = _extract_jsonld_event(detail_html)
        if ld_event is None:
            continue

        start_date = ld_event.get("startDate")
        if not start_date:
            continue
        try:
            start = datetime.datetime.fromisoformat(start_date)
        except ValueError:
            continue
        event_date = start.date()
        if not (week_start <= event_date <= week_end):
            continue

        location = ld_event.get("location") or {}
        venue = html.unescape(str(location.get("name") or ""))
        address = str(location.get("address") or "")
        if address:
            venue = f"{venue}, {address}" if venue else address

        events.append(
            write_event(
                title=html.unescape(str(ld_event.get("name") or candidate.get("title") or "")),
                venue=venue,
                date=str(event_date),
                time=start.strftime("%-I:%M %p"),
                cost="",
                url=str(candidate.get("href") or ""),
                description=html.unescape(str(ld_event.get("description") or "")),
            )
        )

    return events
