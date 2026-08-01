#!/usr/bin/env python3
"""Runs a full Collection pass for one week, deterministically, with no model.

This is the GitHub Actions replacement for the Collection Routine. Every
source it runs is backed by a tested parser in scripts/event_parsers/ -- there
is no step where anything reads page text and transcribes fields by hand,
which is the failure class that produced both the 2026-07-27 fabrication
(17 source files sharing one made-up timestamp) and the 2026-08-01 silent
`url` drop across the three Google Calendar sources. A workflow has no
session budget to exhaust and no judgment to exercise: it completes or it
fails loudly.

Source registry below mirrors philadelphia-sources/SKILL.md, which remains
the spec of record (per-source URLs, quirks, and the reasoning behind each
method). Two kinds of source:

  SIMPLE_SOURCES     one fetch -> one registered parser (the fetch_raw.py |
                     parse_events.py pipeline, run in-process here)
  COLLECTOR_SOURCES  delegated to collect_source.py, which owns a multi-fetch
                     loop (per-day URLs, pagination, index+detail pairs)

Every source is isolated: one failing never aborts the run or the others. A
source that raises is recorded `status: failed` with its reason, matching the
manifest convention the Routine used and check_yield.py validates.

Usage:
    python scripts/collect_week.py                 # next Monday's week
    python scripts/collect_week.py --week-start 2026-08-03
    python scripts/collect_week.py --only do215,wxpn   # subset, for debugging
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import collect_source
import common
from event_parsers import PARSERS, ParseError
from fetch_raw import fetch_raw

# (output filename stem, source name, URL, parser key)
# URLs and per-source reasoning live in philadelphia-sources/SKILL.md.
SIMPLE_SOURCES: list[tuple[str, str, str, str]] = [
    ("philly-ask-a-punk", "Philly Ask A Punk", "https://philly.askapunk.net/api/events", "philly-ask-a-punk"),
    (
        "luma",
        "Luma",
        "https://api.luma.com/ics/get?entity=discover&id=discplace-VGLZZfVwOKRD1Yd",
        "luma-ical",
    ),
    ("r5-productions", "R5 Productions", "https://r5productions.com/events/", "r5-productions"),
    ("philamoca", "PhilaMOCA", "https://www.philamoca.org/", "philamoca"),
    ("cinespeak", "cinéSPEAK", "https://cinespeak.org/cinema/", "cinespeak"),
    ("phillygoth", "Phillygoth.net", "https://phillygoth.net/", "phillygoth"),
    ("philly-shows", "Philly-Shows.com", "https://www.philly-shows.com/", "philly-shows"),
]

# (filename stem, display name, meetup URL slug) -- all share the meetup-ical parser.
MEETUP_GROUPS: list[tuple[str, str, str]] = [
    ("meetup-philadelphia-horror-meetup-group", "Meetup: Philadelphia Horror", "philadelphia-horror-meetup-group"),
    ("meetup-code-coffee", "Meetup: Code & Coffee", "code-coffee-philly"),
    ("meetup-ai-philly", "Meetup: AI Philly", "ai-philly"),
    ("meetup-tech-in-motion", "Meetup: Tech in Motion", "techinmotionphilly"),
    ("meetup-dc215", "Meetup: DC 215", "dc_215"),
    ("meetup-owasp", "Meetup: OWASP", "owasp-philadelphia-chapter"),
    ("meetup-philly-hardware", "Meetup: Philly Hardware", "philly-hardware"),
    ("meetup-philly-film-club", "Meetup: Philly Film Club", "philly-film-club"),
]

# Sources whose fetching is a loop owned by collect_source.py.
# (filename stem, source name, collect_source key)
COLLECTOR_SOURCES: list[tuple[str, str, str]] = [
    ("do215", "Do215", "do215"),
    ("wxpn", "WXPN", "wxpn"),
    ("lightbox-film-center", "Lightbox Film Center", "lightbox-film-center"),
    ("philadelphia-film-society", "Philadelphia Film Society", "philadelphia-film-society"),
    ("iffy-books", "Iffy Books", "iffy-books"),
    ("wooden-shoe-books", "Wooden Shoe Books", "wooden-shoe-books"),
    ("trakt-film-releases", "Trakt.tv film releases", "trakt-film-releases"),
]

_MAX_FETCH_CHARS = 200_000


def _write_source(out_dir: Path, stem: str, source_name: str, events: list[dict]) -> None:
    payload = {
        "source": source_name,
        "collected_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "events": events,
    }
    (out_dir / f"{stem}.json").write_text(json.dumps(payload, indent=2))


def _write_failure(out_dir: Path, stem: str, source_name: str, reason: str) -> None:
    payload = {
        "source": source_name,
        "status": "failed",
        "reason": reason,
        "collected_at": datetime.datetime.now(datetime.UTC).isoformat(),
    }
    (out_dir / f"{stem}.json").write_text(json.dumps(payload, indent=2))


def collect_simple(
    out_dir: Path, stem: str, source_name: str, url: str, parser_key: str,
    week_start: datetime.date, week_end: datetime.date, **parser_kwargs: object,
) -> int:
    raw = fetch_raw(url, _MAX_FETCH_CHARS)
    events = PARSERS[parser_key](raw, week_start, week_end, **parser_kwargs)
    _write_source(out_dir, stem, source_name, events)
    return len(events)


def collect_rotunda(
    out_dir: Path, week_start: datetime.date, week_end: datetime.date
) -> int:
    """The Rotunda's page is a monthly calendar grid whose HTML doesn't say
    which month it represents, so the parser needs --context-date. A week
    spanning two months needs both months fetched and merged (SKILL.md §3)."""
    months = {week_start.replace(day=1)}
    months.add(week_end.replace(day=1))

    merged: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for month_start in sorted(months):
        url = f"https://www.therotunda.org/events?date={month_start.isoformat()}"
        raw = fetch_raw(url, _MAX_FETCH_CHARS)
        for event in PARSERS["the-rotunda"](raw, week_start, week_end, context_date=month_start):
            key = (event["title"], event["date"])
            if key not in seen:
                seen.add(key)
                merged.append(event)
    _write_source(out_dir, "the-rotunda", "The Rotunda", merged)
    return len(merged)


def collect_via_collector(
    out_dir: Path, stem: str, source_name: str, key: str,
    week_start: datetime.date, week_end: datetime.date,
) -> tuple[int, list[str]]:
    result = collect_source.COLLECTORS[key](week_start, week_end)
    if not result.raw_events and result.failed_requests:
        raise ParseError(
            f"every request failed ({len(result.failed_requests)} attempted); "
            f"first: {result.failed_requests[0]}"
        )
    merged_raw = collect_source.RAW_WRAPPERS[key](result.raw_events)
    events = collect_source.PARSE_FUNCS[key](merged_raw, week_start, week_end)
    _write_source(out_dir, stem, source_name, events)
    return len(events), result.failed_requests


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--week-start", help="YYYY-MM-DD (Monday). Defaults to the next upcoming Monday.")
    parser.add_argument("--out-root", type=Path, default=common.DATA_DIR, help="Defaults to data/")
    parser.add_argument("--only", help="Comma-separated filename stems, for debugging a subset")
    args = parser.parse_args()

    week_start = (
        datetime.date.fromisoformat(args.week_start) if args.week_start else common.target_week_monday()
    )
    week_end = week_start + datetime.timedelta(days=6)
    only = {s.strip() for s in args.only.split(",")} if args.only else None

    out_dir = args.out_root / week_start.isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)

    run_started = datetime.datetime.now(datetime.UTC)
    print(f"Collecting {week_start} .. {week_end} into {out_dir}", file=sys.stderr)

    manifest_sources: dict[str, dict] = {}

    def record_ok(stem: str, count: int, note: str | None = None) -> None:
        entry: dict = {"status": "ok", "events": count}
        if note:
            entry["note"] = note
        manifest_sources[stem] = entry
        print(f"{stem}: {count} events written.{' ' + note if note else ''}", file=sys.stderr)

    def record_failed(stem: str, source_name: str, exc: BaseException) -> None:
        reason = f"{type(exc).__name__}: {exc}"
        manifest_sources[stem] = {"status": "failed", "reason": reason}
        _write_failure(out_dir, stem, source_name, reason)
        print(f"{stem}: FAILED -- {reason}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    # --- simple one-fetch sources -------------------------------------------
    for stem, source_name, url, parser_key in SIMPLE_SOURCES:
        if only and stem not in only:
            continue
        try:
            record_ok(stem, collect_simple(out_dir, stem, source_name, url, parser_key, week_start, week_end))
        except Exception as exc:  # noqa: BLE001 -- per-source isolation is the whole point
            record_failed(stem, source_name, exc)

    # --- the-rotunda (needs context_date, may span two months) ---------------
    if not only or "the-rotunda" in only:
        try:
            record_ok("the-rotunda", collect_rotunda(out_dir, week_start, week_end))
        except Exception as exc:  # noqa: BLE001
            record_failed("the-rotunda", "The Rotunda", exc)

    # --- meetup groups (8, same parser) --------------------------------------
    for stem, source_name, slug in MEETUP_GROUPS:
        if only and stem not in only:
            continue
        url = f"https://www.meetup.com/{slug}/events/ical/"
        try:
            record_ok(stem, collect_simple(out_dir, stem, source_name, url, "meetup-ical", week_start, week_end))
        except Exception as exc:  # noqa: BLE001
            record_failed(stem, source_name, exc)

    # --- collector-backed sources -------------------------------------------
    for stem, source_name, key in COLLECTOR_SOURCES:
        if only and stem not in only:
            continue
        try:
            count, failed_requests = collect_via_collector(
                out_dir, stem, source_name, key, week_start, week_end
            )
            note = f"partial -- {len(failed_requests)} request(s) failed" if failed_requests else None
            record_ok(stem, count, note)
        except Exception as exc:  # noqa: BLE001
            record_failed(stem, source_name, exc)

    manifest = {
        "week": week_start.isoformat(),
        "run_started": run_started.isoformat(),
        "run_completed": datetime.datetime.now(datetime.UTC).isoformat(),
        "sources": dict(sorted(manifest_sources.items())),
    }
    (out_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2))

    ok = sum(1 for v in manifest_sources.values() if v["status"] == "ok")
    failed = [k for k, v in manifest_sources.items() if v["status"] != "ok"]
    total = sum(v.get("events", 0) for v in manifest_sources.values())
    print(
        f"\nCollection complete. {ok}/{len(manifest_sources)} sources ok"
        + (f", {len(failed)} failed ({', '.join(failed)})" if failed else "")
        + f".\n{total} total events written to {out_dir}.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
