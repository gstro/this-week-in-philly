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
import json
import sys
from collections.abc import Callable
from dataclasses import dataclass

from event_parsers import Event, ParseError, do215, lightbox, wxpn
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


# Each collector fetches its source's raw data (as many requests as needed)
# and returns it merged into one blob ready for that source's pure parser --
# adding a new multi-fetch source means adding one entry here, following the
# same "add a source" shape as event_parsers/__init__.py's PARSERS registry.
COLLECTORS: dict[str, Callable[[datetime.date, datetime.date], FetchResult]] = {
    "do215": collect_do215,
    "wxpn": collect_wxpn,
    "lightbox-film-center": collect_lightbox,
}

PARSE_FUNCS: dict[str, Callable[..., list[Event]]] = {
    "do215": do215.parse,
    "wxpn": wxpn.parse,
    "lightbox-film-center": lightbox.parse,
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
