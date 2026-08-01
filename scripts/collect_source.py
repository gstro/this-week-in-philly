#!/usr/bin/env python3
"""Owns the multi-fetch loop for sources whose deterministic method needs more
than one HTTP request per week (paginated APIs, per-day URLs, index+detail
pairs).

scripts/parse_events.py's contract is "one fetch -> stdin -> one parser call"
-- that's the right shape for sources needing exactly one request, but wrong
for a source like do215, whose real yield lives behind 7 day-URLs times up to
several pages each. Making the model orchestrate that loop by hand, one Bash
call at a time, is exactly the budget-exhaustion path that produced fabricated
empty results for the week of 2026-07-27 (see check_yield.py's module
docstring) -- so this script owns the loop instead. There is no model in it:
every fetch, every page, every merge is code, and the parser it hands the
merged result to is the same pure `event_parsers` module `parse_events.py`
would use for a single-request source.

Usage:
    python scripts/collect_source.py do215 \\
        --week-start 2026-08-03 --week-end 2026-08-09 \\
        --out data/2026-08-03/do215.json

Exits 1 and does NOT write the output file if every fetch in the loop fails
-- writing a plausible-looking empty file on total failure is the specific
failure mode this script exists to avoid. A partial failure (some fetches
succeeded) still writes the file from what succeeded, with a warning on
stderr noting which fetches failed, matching v1's own "partial" convention
for this exact situation.
"""

from __future__ import annotations

import argparse
import datetime
import functools
import json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

from event_parsers import (
    Event,
    ParseError,
    do215,
    gcal,
    lightbox,
    philadelphia_film_society,
    wxpn,
)
from fetch_page_text import fetch_text
from proxy_session import build_session

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Per-day pagination cap. Observed live (2026-07-29): a typical day is 1-3
# pages; a big day (concerts + a multi-week festival re-listed daily) hit 4.
# Capped well above the observed ceiling rather than left unbounded, since
# an unbounded loop is its own silent-cost risk (see docs/COLLECTION_PROXY_ISSUE.md
# for what unbounded pagination cost Songkick under the proxy workaround).
_MAX_PAGES_PER_DAY = 6

# WXPN's REST API sorts by publish date, not event date, so a page's
# position tells you nothing about which week it covers -- every page must
# be fetched to be sure nothing in the target week is missed. Observed live
# (2026-07-29): 495 total records across 5 pages of 100 (the API's own
# per_page cap). Capped one page above that observed ceiling.
_MAX_PAGES_WXPN = 6

# Calendar API queries are bounded by wall-clock instants, so the target week's
# Mon 00:00 -> Sun 23:59 has to be expressed in Philadelphia's timezone, not
# the runner's UTC -- otherwise a Sunday-evening event lands outside the window.
_EASTERN = ZoneInfo("America/New_York")


@dataclass
class FetchResult:
    raw_events: list[dict]
    failed_requests: list[str]


def _fetch_do215_day(session, day: datetime.date) -> tuple[list[dict], list[str]]:  # noqa: ANN001
    """Fetches every page for one day's do215.com listing. Returns (raw event
    dicts across all pages, list of request descriptions that failed)."""
    base_url = f"https://do215.com/events/{day.year}/{day.month}/{day.day}.json"
    events: list[dict] = []
    failed: list[str] = []
    page = 1
    total_pages = 1
    while page <= min(total_pages, _MAX_PAGES_PER_DAY):
        url = base_url if page == 1 else f"{base_url}?page={page}"
        try:
            response = session.get(url, headers={"User-Agent": _USER_AGENT}, timeout=20)
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:  # noqa: BLE001 -- any failure here just means "skip this page", not crash the run
            failed.append(f"{url} ({exc})")
            page += 1
            continue
        events.extend(payload.get("events", []))
        total_pages = payload.get("paging", {}).get("total_pages", 1)
        page += 1
    return events, failed


def collect_do215(week_start: datetime.date, week_end: datetime.date) -> FetchResult:
    session = build_session()
    all_events: list[dict] = []
    all_failed: list[str] = []
    day = week_start
    while day <= week_end:
        day_events, day_failed = _fetch_do215_day(session, day)
        all_events.extend(day_events)
        all_failed.extend(day_failed)
        day += datetime.timedelta(days=1)
    return FetchResult(raw_events=all_events, failed_requests=all_failed)


_WXPN_API_URL = "https://backend.xpn.org/wp-json/wp/v2/event"


def collect_wxpn(_week_start: datetime.date, _week_end: datetime.date) -> FetchResult:
    # week_start/week_end are unused here -- the API has no server-side date
    # filter (see wxpn.py's module docstring), so every page must be fetched
    # regardless of window; filtering happens entirely in the parser.
    session = build_session()
    events: list[dict] = []
    failed: list[str] = []
    page = 1
    total_pages = 1
    while page <= min(total_pages, _MAX_PAGES_WXPN):
        url = f"{_WXPN_API_URL}?per_page=100&page={page}"
        try:
            response = session.get(url, headers={"User-Agent": _USER_AGENT}, timeout=20)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise TypeError(f"expected a JSON array, got {type(payload).__name__}")
        except Exception as exc:  # noqa: BLE001 -- any failure here just means "skip this page", not crash the run
            failed.append(f"{url} ({exc})")
            page += 1
            continue
        events.extend(payload)
        total_pages = int(response.headers.get("X-WP-TotalPages", page))
        page += 1
    return FetchResult(raw_events=events, failed_requests=failed)


_LIGHTBOX_HOMEPAGE = "https://www.lightboxfilmcenter.org/"


def collect_lightbox(_week_start: datetime.date, _week_end: datetime.date) -> FetchResult:
    # week_start/week_end are unused here -- the homepage index has no
    # server-side date filter and only ever lists a small, bounded number of
    # upcoming events (see lightbox.py's module docstring), so every listed
    # detail page is fetched; the real date filter runs in the parser
    # against each detail page's authoritative JSON-LD startDate.
    session = build_session()
    try:
        response = session.get(_LIGHTBOX_HOMEPAGE, headers={"User-Agent": _USER_AGENT}, timeout=20)
        response.raise_for_status()
        candidates = lightbox.parse_index(response.text)
    except ParseError:
        raise  # structural break in the index itself -- let main() report this as a real failure, not an empty file
    except Exception as exc:
        raise ParseError(f"failed to fetch or parse the lightbox-film-center homepage: {exc}") from exc

    events: list[dict] = []
    failed: list[str] = []
    for candidate in candidates:
        url = candidate["href"]
        try:
            detail_response = session.get(url, headers={"User-Agent": _USER_AGENT}, timeout=20)
            detail_response.raise_for_status()
            detail_html = detail_response.text
        except Exception as exc:  # noqa: BLE001 -- one candidate's detail fetch failing shouldn't kill the others
            failed.append(f"{url} ({exc})")
            detail_html = None
        events.append({"title": candidate["title"], "href": url, "detail_html": detail_html})

    return FetchResult(raw_events=events, failed_requests=failed)


# The 3 venues Philadelphia Film Society sells tickets for on Fandango (per
# philadelphia-sources/SKILL.md's venue list) -- fixed and known, so the
# collector attaches each venue's real name/address directly rather than
# trying to re-derive it from Fandango's page text (see
# philadelphia_film_society.py's module docstring for why).
_PFS_VENUES = [
    {
        "name": "PFS Film Society Center",
        "address": "1412 Chestnut Street, Philadelphia, PA 19102",
        "url": "https://www.fandango.com/pfs-film-society-center-aaxow/theater-page",
    },
    {
        "name": "PFS Bourse Theater",
        "address": "400 Ranstead St, Philadelphia, PA 19106",
        "url": "https://www.fandango.com/pfs-bourse-theater-aadjc/theater-page",
    },
    {
        "name": "PFS East Theater",
        "address": "125 S. 2nd Street, Philadelphia, PA 19106",
        "url": "https://www.fandango.com/pfs-east-theater-aandq/theater-page",
    },
]


def collect_philadelphia_film_society(week_start: datetime.date, week_end: datetime.date) -> FetchResult:
    # Two representative days per venue (Wednesday + Saturday of the target
    # week), not all 7: confirmed live 2026-08-01 that PFS's own day-picker
    # skips straight from Sunday to the following Wednesday for weeks
    # further out, suggesting programming runs in Wed-Sun blocks rather than
    # changing daily -- though this is inferred from the calendar widget's
    # available-days pattern, not confirmed by comparing two same-block days'
    # actual lineups directly. Each fetch needs a full browser render
    # (~15-30s observed), so 6 fetches keeps this to a few minutes rather
    # than the 10+ a full 7-day sweep across 3 venues would cost. Each
    # (venue, day) fetch is isolated -- one hanging or erroring must not take
    # the other 5 down with it, which is what the observed real failures
    # ("Fandango pages unavailable (Playwright timeout)") are consistent with.
    sample_days = [week_start + datetime.timedelta(days=2), week_start + datetime.timedelta(days=5)]  # Wed, Sat

    entries: list[dict] = []
    failed: list[str] = []
    for venue in _PFS_VENUES:
        for day in sample_days:
            url = f"{venue['url']}?date={day.isoformat()}"
            try:
                rendered_text = fetch_text(url, wait_ms=0, max_chars=20_000)
            except Exception as exc:  # noqa: BLE001 -- one venue/day failing shouldn't kill the other 5
                failed.append(f"{url} ({exc})")
                rendered_text = None
            entries.append(
                {
                    "venue_name": venue["name"],
                    "venue_address": venue["address"],
                    "theater_url": venue["url"],
                    "context_date": day.isoformat(),
                    "rendered_text": rendered_text,
                }
            )
    return FetchResult(raw_events=entries, failed_requests=failed)


# The three venue calendars from philadelphia-sources/SKILL.md's Google
# Calendar table. These are third-party/public calendars addressed by ID --
# NOT Greg's own "Curated Events" calendar, so common.get_calendar_id()
# (which name-searches the authenticated account's calendar list) must not be
# used here. `venue` and `fallback_url` are per-calendar facts the API's event
# resources don't carry; the parser uses them to fill gaps.
_GCAL_CALENDARS = {
    "iffy-books": {
        "calendar_id": "uim84nkq226inhhqa44v98foigjak9us@import.calendar.google.com",
        "venue": "Iffy Books, 404 S. 20th St., Philadelphia, PA 19146",
        "fallback_url": "https://iffybooks.net/",
    },
    "wooden-shoe-books": {
        "calendar_id": "t8qmive63n27mdj7gt03ntc2u8@group.calendar.google.com",
        "venue": "Wooden Shoe Books, 704 South St, Philadelphia, PA 19147",
        "fallback_url": "https://woodenshoebooks.org/",
    },
    "trakt-film-releases": {
        "calendar_id": "3c3o7i2bfqmvbss5lckns84vkedh4gqd@import.calendar.google.com",
        # Theatrical releases aren't tied to a venue; philly-events-selection's
        # schema notes say to set venue to "Theatrical release" when absent.
        "venue": "Theatrical release",
        "fallback_url": "",
    },
}


def _collect_gcal(source_key: str, week_start: datetime.date, week_end: datetime.date) -> FetchResult:
    """Reads one venue calendar over the target week via the Calendar API.

    Replaces the `gcal_list_events` MCP tool, which only exists inside a
    Claude session -- see event_parsers/gcal.py for the data-loss incident
    that made a tested path here necessary.
    """
    import common  # local import: keeps the Google deps off every other collector's path

    config = _GCAL_CALENDARS[source_key]
    start = datetime.datetime.combine(week_start, datetime.time.min, tzinfo=_EASTERN)
    end = datetime.datetime.combine(week_end, datetime.time.max, tzinfo=_EASTERN)

    try:
        service = common.get_calendar_service()
    except Exception as exc:
        raise ParseError(f"Google Calendar auth failed: {exc}") from exc

    # list[Any], not list[dict]: google-api-python-client-stubs types the
    # response's "items" as its own Event TypedDict, which collides with
    # event_parsers.Event imported above -- and we only pass these straight
    # through to gcal.parse anyway.
    items: list[Any] = []
    failed: list[str] = []
    page_token = None
    while True:
        try:
            result = (
                service.events()
                .list(
                    calendarId=config["calendar_id"],
                    timeMin=start.isoformat(),
                    timeMax=end.isoformat(),
                    singleEvents=True,
                    orderBy="startTime",
                    timeZone=common.CALENDAR_TIMEZONE,
                    pageToken=page_token,
                )
                .execute()
            )
        except Exception as exc:  # noqa: BLE001 -- one page failing shouldn't lose the pages already read
            failed.append(f"{source_key} calendar page (token={page_token}) ({exc})")
            break
        items.extend(result.get("items", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            break

    # gcal.parse expects the API's own {"items": [...]} envelope plus the two
    # per-calendar extras; RAW_WRAPPERS below re-attaches them after the
    # collector/parser boundary flattens everything to a list.
    entries = [{"_gcal_meta": {"venue": config["venue"], "fallback_url": config["fallback_url"]}}, *items]
    return FetchResult(raw_events=entries, failed_requests=failed)


def _wrap_gcal(entries: list[dict]) -> str:
    """Splits the meta marker back out of the flattened collector output."""
    meta: dict = {}
    items = []
    for entry in entries:
        if "_gcal_meta" in entry:
            meta = entry["_gcal_meta"]
        else:
            items.append(entry)
    return json.dumps({"items": items, **meta})


# Each collector fetches its source's raw data (as many requests as needed)
# and returns it merged into one blob ready for that source's pure parser --
# adding a new multi-fetch source means adding one entry here, following the
# same "add a source" shape as event_parsers/__init__.py's PARSERS registry.
COLLECTORS: dict[str, Callable[[datetime.date, datetime.date], FetchResult]] = {
    "do215": collect_do215,
    "wxpn": collect_wxpn,
    "lightbox-film-center": collect_lightbox,
    "philadelphia-film-society": collect_philadelphia_film_society,
    **{key: functools.partial(_collect_gcal, key) for key in _GCAL_CALENDARS},
}

PARSE_FUNCS: dict[str, Callable[..., list[Event]]] = {
    "do215": do215.parse,
    "wxpn": wxpn.parse,
    "lightbox-film-center": lightbox.parse,
    "philadelphia-film-society": philadelphia_film_society.parse,
    **dict.fromkeys(_GCAL_CALENDARS, gcal.parse),
}

# Each source's parser expects raw JSON in its own shape (do215: an object
# with an "events" key, matching its raw API page shape; wxpn: a bare array,
# matching the WP REST API's own list response) -- this wraps the collector's
# merged `list[dict]` into whatever shape that source's parser was written
# to accept, so each parser module can stay a faithful match for its real
# API response rather than conforming to some artificial common envelope.
RAW_WRAPPERS: dict[str, Callable[[list[dict]], str]] = {
    "do215": lambda events: json.dumps({"events": events}),
    "wxpn": json.dumps,
    "lightbox-film-center": json.dumps,
    "philadelphia-film-society": json.dumps,
    **dict.fromkeys(_GCAL_CALENDARS, _wrap_gcal),
}


def build_output(source_name: str, events: list[Event]) -> dict:
    return {
        "source": source_name,
        "collected_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source_key", choices=sorted(COLLECTORS.keys()))
    parser.add_argument("--source-name", required=True, help='Value for the output JSON\'s "source" field')
    parser.add_argument("--week-start", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument("--week-end", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument("--out", required=True, help="Output file path")
    args = parser.parse_args()

    week_start = datetime.date.fromisoformat(args.week_start)
    week_end = datetime.date.fromisoformat(args.week_end)

    try:
        result = COLLECTORS[args.source_key](week_start, week_end)
    except ParseError as exc:
        # A structural break in the source itself (e.g. lightbox's homepage
        # index losing its events-card markup entirely) -- not a per-request
        # network failure, which collectors handle themselves and report via
        # FetchResult.failed_requests instead.
        print(f"FAILED to collect {args.source_key}: {exc}", file=sys.stderr)
        sys.exit(1)

    if not result.raw_events and result.failed_requests:
        print(
            f"FAILED to collect {args.source_key}: every request failed "
            f"({len(result.failed_requests)} attempted). Not writing an empty file. "
            f"First failure: {result.failed_requests[0]}",
            file=sys.stderr,
        )
        sys.exit(1)

    merged_raw = RAW_WRAPPERS[args.source_key](result.raw_events)
    try:
        events = PARSE_FUNCS[args.source_key](merged_raw, week_start, week_end)
    except ParseError as exc:
        print(f"FAILED to parse ({args.source_key}): {exc}", file=sys.stderr)
        sys.exit(1)

    with open(args.out, "w") as f:
        json.dump(build_output(args.source_name, events), f, indent=2)

    if result.failed_requests:
        print(
            f"WARNING: {len(result.failed_requests)} request(s) failed during collection "
            f"(partial result -- see below), but {len(events)} events were still written.",
            file=sys.stderr,
        )
        for failure in result.failed_requests:
            print(f"  FAILED: {failure}", file=sys.stderr)

    # Matches philadelphia-sources/SKILL.md's Confirmation Turn Format exactly,
    # so the model relays this line verbatim into the manifest/summary.
    print(f"{args.source_name}: {len(events)} events written. Proceeding.", file=sys.stderr)


if __name__ == "__main__":
    main()
