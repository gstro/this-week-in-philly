#!/usr/bin/env python3
"""Deterministic pre-filter for Selection's input.

Runs as a step in .github/workflows/collection.yml, after check_yield.py
passes and before the commit -- so its output lands in the same commit as
the rest of Collection's data. That placement isn't arbitrary: commits
pushed with the default GITHUB_TOKEN don't retrigger `on: push` workflows,
which is why check_yield.py already runs inline inside collection.yml
rather than relying solely on collection-check.yml. The same constraint
rules out a separate push-triggered workflow for this script, and rules
out leaving it to Selection's Routine to invoke correctly every week.

Reads _manifest.json + every status:ok source file in a week directory and
writes one flattened, deduped, annotated candidate list to
data/YYYY-MM-DD/_candidates.json, so Selection's Routine reads one correct
file instead of re-deriving this itself in an LLM session every week.

Three mechanical things docs/v1/Scheduled/philly-events-selection/SKILL.md
did in prose belong here instead, because they're fully deterministic:

1. Per-event source tagging. A source's `source` name lives at the FILE
   level ({"source": "...", "events": [...]}), not per-event -- naively
   flattening files without this step loses which source each event came
   from. It also sidesteps a real footgun in the raw per-source files:
   a successful source's file has no `status` field at all (only the
   manifest says status: ok); a failed source's file HAS status: failed
   but no `events` key at all. Filtering by the manifest, never the files
   themselves, avoids a KeyError on every failed source.
2. Exact-duplicate collapse (v1 SKILL.md Phase 2, verbatim): same (title,
   venue, date) -> duplicate. Source priority when merging: R5 Productions
   > PhilaMOCA > Philly Ask A Punk > Do215 > everything else. No clear
   priority -> keep the most complete entry. A sold-out mention in a
   discarded entry's description is preserved as a note on the kept entry
   rather than silently lost.
3. Recurring-listing grouping: same (title, venue) appearing on 3+ distinct
   dates this week collapses to one representative (earliest date), with
   an added occurrences/recurrence_count annotation. Reuses
   events-report-format/SKILL.md's own "3+ days" recurring threshold, not
   a new number. Real motivating case: do215's museum-tour-style daily
   re-listings (data/expected_yield.json's do215 note -- 517 events in a
   real week, ~80 of which are exactly this pattern). Never dropped, only
   annotated -- Selection still applies event-selection-philosophy's
   "Avoid: recurring weekly events unless something special" judgment
   itself, just against ~1 entry per series instead of 5+.

Never touches _selections.json's schema and never makes a judgment call --
scoring, Top 3 selection, and blurb writing stay entirely in Selection's
Routine. Exact-string matching only, no fuzzy title matching: same
limitation v1's own spec had (cross-source duplicates with differently
worded titles/venues won't be caught), not something this script guesses
its way around.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Lower index = higher priority when merging an exact (title, venue, date)
# duplicate. Matches docs/v1/Scheduled/philly-events-selection/SKILL.md
# Phase 2's source-priority list verbatim (its 5th tier, "all other
# sources", is anything not in this list -- see _priority_rank).
SOURCE_PRIORITY = ["R5 Productions", "PhilaMOCA", "Philly Ask A Punk", "Do215"]

# Same (title, venue) on this many distinct dates in the target week or
# more counts as a recurring listing -- reuses events-report-format/
# SKILL.md's own "3+ days" All Week/Recurring threshold rather than
# inventing a new number.
RECURRING_THRESHOLD = 3


def _priority_rank(source: str) -> int:
    """Lower is higher priority. A source not in SOURCE_PRIORITY shares the
    lowest rank with every other unlisted source (v1's "all other sources" tier)."""
    try:
        return SOURCE_PRIORITY.index(source)
    except ValueError:
        return len(SOURCE_PRIORITY)


def _completeness(event: dict[str, Any]) -> int:
    """Count of non-empty optional fields -- the tiebreak v1's spec falls back
    to when no source-priority rule distinguishes two exact-duplicate entries."""
    return sum(1 for field in ("time", "cost", "url", "description") if event.get(field))


def _mentions_sold_out(description: str | None) -> bool:
    return "sold out" in (description or "").casefold()


def load_manifest(week_dir: Path) -> dict[str, Any]:
    with open(week_dir / "_manifest.json") as f:
        return json.load(f)  # type: ignore[no-any-return]


def load_candidates_from_sources(week_dir: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Flattens every status:ok source file into one list, each event tagged
    with `source`. Iterates the manifest, not the files on disk -- a manifest
    entry with no matching file (or vice versa) is check_yield.py's job to
    catch, not this script's; this function just skips what it can't find."""
    events: list[dict[str, Any]] = []
    for stem, entry in manifest.get("sources", {}).items():
        if entry.get("status") != "ok":
            continue
        path = week_dir / f"{stem}.json"
        if not path.exists():
            continue
        with open(path) as f:
            payload = json.load(f)
        source_name = payload.get("source", stem)
        for event in payload.get("events", []):
            tagged = dict(event)
            tagged["source"] = source_name
            events.append(tagged)
    return events


def collapse_exact_duplicates(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Same (title, venue, date) = duplicate. Keeps the highest-source-priority
    entry; on a priority tie, keeps whichever has the most complete optional
    fields. If any discarded entry's description mentions "sold out" and the
    kept entry's doesn't, a note is prepended to the kept entry's description
    rather than dropping that signal."""
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str, str]] = []
    for event in events:
        key = (event.get("title", ""), event.get("venue", ""), event.get("date", ""))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(event)

    collapsed: list[dict[str, Any]] = []
    for key in order:
        group = groups[key]
        if len(group) == 1:
            collapsed.append(group[0])
            continue
        best = min(group, key=lambda e: (_priority_rank(e.get("source", "")), -_completeness(e)))
        others_mention_sold_out = any(e is not best and _mentions_sold_out(e.get("description")) for e in group)
        if others_mention_sold_out and not _mentions_sold_out(best.get("description")):
            best = dict(best)
            best["description"] = (
                "[Note: at least one other source reports this as sold out.] " + (best.get("description") or "")
            ).strip()
        collapsed.append(best)
    return collapsed


def group_recurring(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Same (title, venue) appearing on RECURRING_THRESHOLD+ distinct dates
    collapses to one representative (earliest date), annotated with
    `occurrences` (sorted dates) and `recurrence_count`. Events below the
    threshold pass through unchanged, in original order."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str]] = []
    for event in events:
        key = (event.get("title", ""), event.get("venue", ""))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(event)

    result: list[dict[str, Any]] = []
    for key in order:
        group = groups[key]
        dates = sorted({e.get("date", "") for e in group})
        if len(dates) < RECURRING_THRESHOLD:
            result.extend(group)
            continue
        representative = min(group, key=lambda e: e.get("date", ""))
        annotated = dict(representative)
        annotated["occurrences"] = dates
        annotated["recurrence_count"] = len(dates)
        result.append(annotated)
    return result


def collection_failures(manifest: dict[str, Any]) -> list[str]:
    """Builds the same "{source} ({reason})" shape html_render.py's
    format_failure_note already parses, so Selection can pass this straight
    through to _selections.json's collection_failures field."""
    failures = []
    for stem, entry in sorted(manifest.get("sources", {}).items()):
        if entry.get("status") == "failed":
            reason = entry.get("reason", "unknown reason")
            failures.append(f"{stem} ({reason})")
    return failures


def build_candidates(week_dir: Path) -> dict[str, Any]:
    manifest = load_manifest(week_dir)
    raw_events = load_candidates_from_sources(week_dir, manifest)
    deduped = collapse_exact_duplicates(raw_events)
    grouped = group_recurring(deduped)
    return {
        "week": manifest.get("week", week_dir.name),
        "collection_failures": collection_failures(manifest),
        "raw_event_count": len(raw_events),
        "candidates": grouped,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Flatten, dedupe, and annotate a week's Collection output for Selection")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--out", type=Path, default=None, help="Defaults to <week_dir>/_candidates.json")
    args = parser.parse_args()

    result = build_candidates(args.week_dir)
    out_path = args.out or (args.week_dir / "_candidates.json")
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")

    recurring_groups = sum(1 for c in result["candidates"] if c.get("recurrence_count"))
    print(
        f"Candidate prep complete. {result['raw_event_count']} raw events -> "
        f"{len(result['candidates'])} candidates ({recurring_groups} recurring group(s) collapsed), "
        f"{len(result['collection_failures'])} source(s) failed. Written to {out_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
