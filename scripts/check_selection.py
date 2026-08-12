#!/usr/bin/env python3
"""Mechanical post-conditions for a week's Selection output, modeled on
check_yield.py's role for Collection: the SKILL-level rules in
event-selection-philosophy/SKILL.md and philly-events-selection/SKILL.md's
own Phase 4 self-check are prose a model reads and can drift from, the same
way check_yield.py's docstring describes for the Collection Routine. This
script re-checks the parts of that prose that are actually mechanical, in
CI, where a check the model runs on itself can't be silently skipped.

Runs against a week's merged _selections.json -- after merge_selections.py,
not after Selection's own push -- because `title`, `venue`, and `cost` don't
exist until the merge (see merge_selections.py's docstring). `address` is
Selection's own field and is present earlier, but the venue cap needs the
resolved venue/address pairing the merge produces, so this runs after it
regardless.

Two severities:
  - FAIL issues exit the process nonzero -- the same "any issue -> loud CI
    failure" contract check_yield.py uses for Collection.
  - WARN issues print but don't fail the build -- reserved for checks with a
    plausible legitimate exception (a genuinely late-night show at
    12:30 AM, two workshops that happen to share a title prefix by
    coincidence), where failing the whole week's report over one false
    positive would be worse than the thing being guarded against.

Checks:
  1. Venue cap (FAIL) -- event-selection-philosophy's Weekly Caps: at most
     VENUE_CAP top3 slots per week at the same venue, keyed on `address`
     (falling back to a normalized venue-name prefix when address is
     missing, per the same rule).
  2. Time format (FAIL) -- regression guard for the defect fixed in
     9bbd592: every top3 pick's `time` must be a single `%I:%M %p` string,
     never a list, a doors/show pair, or a range. A malformed time means
     calendar_create.py's parse_start() silently never creates that pick's
     calendar entry -- confirmed on 5 of 21 real 2026-08-03 picks before the
     fix.
  3. Cost not blank (FAIL) -- regression guard for merge_selections.py's
     "Not listed" default (see its docstring): an empty cost string reaching
     _selections.json means that default was bypassed somehow.
  4. Implausible start time (WARN) -- a top3 pick starting between 12:00 AM
     and 5:59 AM is usually a scrape artifact (a listing's creation
     timestamp, a "doors at midnight" misparse), per
     event-selection-philosophy's Data Plausibility Checklist -- but a real
     late show is possible, so this is flagged for review, not failed.
  5. Same-title-prefix duplicate (WARN) -- a soft heuristic for the
     same-series cap: two top3 picks in one week sharing both a venue and a
     title prefix before the first colon or dash (e.g. "Beginner Soldering:
     Li-Ion Battery Pack" / "Beginner Soldering: LED Spinning Top") likely
     belong to the same series. Titles vary more than this catches, which is
     why the SKILL-level rule (Selection's own judgment, tracked live) is
     still the primary enforcement -- this is a backstop, not authoritative.

Also prints a venue/category/source histogram unconditionally -- not an
Issue, informational, the same numbers philly-events-selection/SKILL.md's
Phase 4 self-check asks the model to print at authoring time. This is the
CI-side confirmation of those numbers.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

VENUE_CAP = 2
IMPLAUSIBLE_HOUR_START = 0  # 12:00 AM
IMPLAUSIBLE_HOUR_END = 6  # up to, not including, 6:00 AM

TIME_RE = re.compile(r"^\d{1,2}:\d{2} [AP]M$")


@dataclass
class Issue:
    check: str
    severity: str  # "fail" | "warn"
    day: str | None
    title: str | None
    message: str


def _iter_top3(selections: dict) -> list[tuple[str, dict]]:
    """Returns (day_date, pick) for every top3 pick in the week, in file order."""
    picks = []
    for day in selections.get("days", []):
        for pick in day.get("top3", []):
            picks.append((day.get("date", "?"), pick))
    return picks


def normalize_venue(venue: str) -> str:
    """Fallback key for the venue cap when a pick has no `address` -- the
    text before the first comma, lowercased. Matches
    event-selection-philosophy/SKILL.md's Weekly Caps fallback rule."""
    return venue.split(",")[0].strip().lower()


def _venue_key(pick: dict) -> str:
    address = pick.get("address")
    if address:
        return address.strip().lower()
    return normalize_venue(pick.get("venue", ""))


def check_venue_cap(selections: dict) -> list[Issue]:
    issues: list[Issue] = []
    by_venue: dict[str, list[tuple[str, dict]]] = {}
    for day_date, pick in _iter_top3(selections):
        by_venue.setdefault(_venue_key(pick), []).append((day_date, pick))

    for venue_key, picks in by_venue.items():
        if len(picks) > VENUE_CAP:
            days = ", ".join(f"{d} ({p.get('title', '?')!r})" for d, p in picks)
            issues.append(
                Issue(
                    "venue_cap",
                    "fail",
                    None,
                    None,
                    f"{venue_key!r} took {len(picks)} top3 slots this week (cap {VENUE_CAP}): {days}",
                )
            )
    return issues


def check_time_format(selections: dict) -> list[Issue]:
    issues: list[Issue] = []
    for day_date, pick in _iter_top3(selections):
        time_value = pick.get("time", "")
        if not TIME_RE.match(time_value or ""):
            issues.append(
                Issue(
                    "time_format",
                    "fail",
                    day_date,
                    pick.get("title"),
                    f"time {time_value!r} is not a single H:MM AM/PM value -- calendar_create.py's "
                    f"parse_start() will silently drop this pick's calendar entry",
                )
            )
    return issues


def check_cost_not_blank(selections: dict) -> list[Issue]:
    issues: list[Issue] = []
    for day in selections.get("days", []):
        for pick in day.get("top3", []):
            if not (pick.get("cost") or "").strip():
                issues.append(
                    Issue(
                        "cost_blank",
                        "fail",
                        day.get("date"),
                        pick.get("title"),
                        "top3 pick has a blank cost -- merge_selections.py's 'Not listed' default was bypassed",
                    )
                )
        for event in day.get("events", []):
            if not (event.get("cost") or "").strip():
                issues.append(
                    Issue(
                        "cost_blank",
                        "fail",
                        day.get("date"),
                        event.get("title"),
                        "listed event has a blank cost -- merge_selections.py's 'Not listed' default was bypassed",
                    )
                )
    return issues


def check_implausible_start_time(selections: dict) -> list[Issue]:
    issues: list[Issue] = []
    for day_date, pick in _iter_top3(selections):
        time_value = pick.get("time", "")
        try:
            parsed = datetime.strptime(time_value, "%I:%M %p")  # noqa: DTZ007 -- .hour only
        except ValueError:
            continue  # already flagged by check_time_format if malformed
        if IMPLAUSIBLE_HOUR_START <= parsed.hour < IMPLAUSIBLE_HOUR_END:
            issues.append(
                Issue(
                    "implausible_time",
                    "warn",
                    day_date,
                    pick.get("title"),
                    f"starts at {time_value} -- often a scrape artifact per the Data Plausibility "
                    f"Checklist; confirm this is really the start time before trusting it",
                )
            )
    return issues


def _series_prefix(title: str) -> str | None:
    for sep in (":", " - ", "—"):
        if sep in title:
            prefix = title.split(sep, 1)[0].strip()
            if prefix:
                return prefix.lower()
    return None


def check_same_series(selections: dict) -> list[Issue]:
    issues: list[Issue] = []
    seen: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for day_date, pick in _iter_top3(selections):
        prefix = _series_prefix(pick.get("title", ""))
        if prefix is None:
            continue
        key = (_venue_key(pick), prefix)
        seen.setdefault(key, []).append((day_date, pick.get("title", "")))

    for (venue_key, prefix), occurrences in seen.items():
        if len(occurrences) > 1:
            days = ", ".join(f"{d} ({t!r})" for d, t in occurrences)
            issues.append(
                Issue(
                    "same_series",
                    "warn",
                    None,
                    None,
                    f"{len(occurrences)} top3 picks at {venue_key!r} share the title prefix {prefix!r} "
                    f"-- possibly the same series (event-selection-philosophy's same-series cap): {days}",
                )
            )
    return issues


def collect_issues(selections: dict) -> list[Issue]:
    return [
        *check_venue_cap(selections),
        *check_time_format(selections),
        *check_cost_not_blank(selections),
        *check_implausible_start_time(selections),
        *check_same_series(selections),
    ]


def summarize(selections: dict) -> str:
    venues: dict[str, int] = {}
    categories: dict[str, int] = {}
    sources: dict[str, int] = {}
    for _day_date, pick in _iter_top3(selections):
        key = _venue_key(pick)
        venues[key] = venues.get(key, 0) + 1
        category = pick.get("category", "?")
        categories[category] = categories.get(category, 0) + 1
        source = pick.get("source", "?")
        sources[source] = sources.get(source, 0) + 1

    def _fmt(counts: dict[str, int]) -> str:
        return ", ".join(f"{k}: {v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))

    return "\n".join(
        [
            "top3 by venue: " + (_fmt(venues) or "(none)"),
            "top3 by category: " + (_fmt(categories) or "(none)"),
            "top3 by source: " + (_fmt(sources) or "(none)"),
        ]
    )


def format_report(issues: list[Issue], week: str) -> str:
    fails = [i for i in issues if i.severity == "fail"]
    warns = [i for i in issues if i.severity == "warn"]
    lines = [f"check_selection: {week}"]

    if not issues:
        lines.append("  no issues found.")
    else:
        by_check: dict[str, list[Issue]] = {}
        for issue in issues:
            by_check.setdefault(issue.check, []).append(issue)
        for check, check_issues in by_check.items():
            lines.append(f"\n{check_issues[0].severity.upper()} -- {check}:")
            for issue in check_issues:
                where = f"[{issue.day}] " if issue.day else ""
                title = f"{issue.title!r}: " if issue.title else ""
                lines.append(f"  {where}{title}{issue.message}")

    lines.append(f"\n{len(fails)} fail(s), {len(warns)} warn(s).")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD (must already contain _selections.json)")
    parser.add_argument("--selections", type=Path, default=None, help="Defaults to <week_dir>/_selections.json")
    args = parser.parse_args()

    selections_path = args.selections or (args.week_dir / "_selections.json")
    with open(selections_path) as f:
        selections = json.load(f)

    issues = collect_issues(selections)
    week = selections.get("week", args.week_dir.name)

    print(format_report(issues, week))
    print()
    print(summarize(selections))

    if any(i.severity == "fail" for i in issues):
        sys.exit(1)


if __name__ == "__main__":
    main()
