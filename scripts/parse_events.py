#!/usr/bin/env python3
"""Deterministically parses fetched source content into the Collection event schema.

Companion to fetch_raw.py: that script fetches a URL with no model in the
loop; this one parses the result with no model in the loop either. Together
they replace a step that used to require Claude to read raw HTML/iCal/JSON
and manually transcribe events -- confirmed live (2026-07-21) that this
produces real, undetected bugs: Claude wrote a one-off regex parser for R5
Productions with a capturing-group bug that silently matched a 12-character
date fragment instead of the real event block, so every event was dropped
and the source reported 0 events with no error, despite fetch_raw.py having
returned the complete, correct page. philadelphia-sources/SKILL.md now
prohibits ad hoc parsing scripts for exactly this reason -- this module is
the tested, version-controlled replacement, not another one-off script.

Usage:
    python scripts/fetch_raw.py <url> | python scripts/parse_events.py \\
        <parser> --source-name "R5 Productions" \\
        --week-start 2026-07-20 --week-end 2026-07-26

This is just the CLI -- the actual parsers live in scripts/event_parsers/,
one small independently-testable module per source (see
tests/test_parse_events.py for real fixture data per source, and
event_parsers/__init__.py for how to add a new one). A parser that finds
its container elements but zero of them fall in the target week returns an
empty list -- a normal, valid result (a genuinely quiet week). A parser
that finds *no container elements at all* raises ParseError instead of
silently returning an empty list, since that almost always means the
source's markup changed, not that the source has no events -- exactly the
failure mode that made the R5 bug invisible. main() catches ParseError and
exits 1 with a clear message so a broken parser fails loudly instead of
writing a plausible-looking empty file.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from typing import Any

from event_parsers import PARSERS, ParseError, Event


def build_output(source_name: str, events: list[Event]) -> dict[str, Any]:
    return {
        "source": source_name,
        "collected_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("parser_key", choices=sorted(PARSERS.keys()))
    parser.add_argument("--source-name", required=True, help='Value for the output JSON\'s "source" field')
    parser.add_argument("--week-start", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument("--week-end", required=True, help="YYYY-MM-DD, inclusive")
    parser.add_argument(
        "--context-date",
        help="YYYY-MM-DD. Required for the-rotunda only -- the same date used in the fetched URL's ?date= param.",
    )
    args = parser.parse_args()

    week_start = datetime.date.fromisoformat(args.week_start)
    week_end = datetime.date.fromisoformat(args.week_end)
    raw = sys.stdin.read()

    kwargs: dict[str, Any] = {}
    if args.context_date:
        kwargs["context_date"] = datetime.date.fromisoformat(args.context_date)

    try:
        events = PARSERS[args.parser_key](raw, week_start, week_end, **kwargs)
    except ParseError as exc:
        print(f"FAILED to parse ({args.parser_key}): {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(build_output(args.source_name, events), indent=2))
    # Printed to stderr, not stdout, so it doesn't corrupt the JSON when stdout
    # is redirected straight to the output file -- lets the caller (Collection)
    # read the real, just-computed count for its confirmation-turn message
    # without re-opening the file it just wrote.
    print(f"{args.source_name}: {len(events)} events parsed.", file=sys.stderr)


if __name__ == "__main__":
    main()
