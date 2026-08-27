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
did in prose belong here instead, because they're fully deterministic. Two
more (id assignment, description capping) exist purely to cut Selection's
token usage without changing what it's allowed to decide:

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
2b. Cross-source duplicate collapse: same (date, normalized title) from more
   than one source -> duplicate, resolved by the same source-priority rule
   as step 2. Step 2 keys on `venue`, which sources spell differently for
   the same room, so ~5% of the pool (21-30 groups a week) survived it.
   Single-source groups are left alone -- that is what keeps five distinct
   Dave & Buster's locations sharing one title from fusing. See
   collapse_cross_source_duplicates' docstring for the full safety
   argument and the published wrong-venue defect that motivated it.
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
4. Stable `id` assignment (c0000-style strings), after grouping so it's
   assigned exactly once against the final deduped/grouped list. Selection's
   annotations and scripts/merge_selections.py key off this id instead of
   re-matching on title text -- closing a real drift bug where a reworded
   title in _selections.json silently failed to join back to its candidate.
5. `description` capped at 600 chars on emit (raw source files untouched).
   Measured against the real 2026-08-03 week: description was 55% of the
   candidates file's token count, and p90 was 751 chars, so this keeps full
   text for ~90% of events while bounding the worst case.

Optionally (--split-by-day) also writes one candidate file per date under
data/YYYY-MM-DD/_candidates/, so a per-day Selection agent reads only its
own day's ~7-20k tokens instead of the whole week's ~86k.

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
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

import common

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

# Applied on emit only -- raw source files under data/<week>/ are never
# touched. Keeps the full text for ~90% of real events (p90 was 751 chars
# on the 2026-08-03 week); the other ~10% lose detail Selection rarely used
# anyway (a `why`/`note` blurb draws from the first sentence or two).
DESCRIPTION_CAP = 600

# Cross-source dedupe title key -- see _normalize_title.
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]")


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


def _normalize_title(title: str | None) -> str:
    """Lowercase, letters and digits only -- the cross-source dedupe key.

    Sources punctuate and case the same title differently ("Christone
    \"Kingfish\" Ingram", "The 36 Th Chamber Of Shaolin"). Never truncated:
    a prefix match would fuse distinct entries in a numbered series
    ("Once Upon A Time In China" / "... Ii" / "... Iii" all ran in one week).
    """
    return _NON_ALNUM_RE.sub("", (title or "").casefold())


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
        collapsed.append(_best_of_group(groups[key]))
    return collapsed


def _best_of_group(group: list[dict[str, Any]]) -> dict[str, Any]:
    """Highest-source-priority entry, breaking a priority tie on completeness.

    Shared by both dedupe passes. If any discarded entry's description
    mentions "sold out" and the kept one's doesn't, prepend a note rather
    than dropping that signal.
    """
    if len(group) == 1:
        return group[0]
    best = min(group, key=lambda e: (_priority_rank(e.get("source", "")), -_completeness(e)))
    others_mention_sold_out = any(e is not best and _mentions_sold_out(e.get("description")) for e in group)
    if others_mention_sold_out and not _mentions_sold_out(best.get("description")):
        best = dict(best)
        best["description"] = (
            "[Note: at least one other source reports this as sold out.] " + (best.get("description") or "")
        ).strip()
    return best


def collapse_cross_source_duplicates(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Same (date, normalized title) from DIFFERENT sources = one event.

    collapse_exact_duplicates() keys on `venue`, and sources spell the same
    room differently ("Philadelphia Film Society" vs "PFS Film Society
    Center, 1412 Chestnut Street, Philadelphia, PA 19102"), so cross-source
    duplicates survive it -- 21-30 groups a week, ~5% of the pool, measured
    over 2026-08-10/-17/-24.

    That cost a published report a wrong venue. 2026-08-10's Top 3 carried
    "REPO MAN X CIRCLE JERKS" with venue "PhilaMOCA, 531 N 12th St,
    Philadelphia, PA 19123" for an event at the Keswick Theatre in Glenside,
    25 miles away: three records existed (R5 Productions and Do215 both said
    Keswick; PhilaMOCA's own feed self-stamps its address onto offsite
    co-presentations), and Selection happened to pick the PhilaMOCA one.
    R5 Productions is first in SOURCE_PRIORITY, so collapsing that group
    would have handed Selection the correct record.

    **Only groups spanning more than one source collapse**, and that
    restriction is the whole safety argument, not an optimization. Grouping
    four real weeks on (date, normalized title) yields 122 multi-record
    groups. The 19 that pair genuinely different rooms -- five Dave &
    Buster's locations sharing "1/2 Price Games Wednesdays", "Wellness
    Walks" at two Awbury sites, PFS's own Film Society Center vs Bourse
    Theater -- are *all* single-source, so this pass never sees them. All 95
    cross-source groups were inspected by hand; every one is a true
    duplicate, including the 29 whose venue strings look unrelated
    ("Highmark Mann" vs "TD Pavilion at The Mann Center").
    """
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str]] = []
    for event in events:
        key = (event.get("date", ""), _normalize_title(event.get("title", "")))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(event)

    collapsed: list[dict[str, Any]] = []
    for key in order:
        group = groups[key]
        if len({e.get("source", "") for e in group}) < 2:
            collapsed.extend(group)  # single-source: may be genuinely different venues
            continue
        collapsed.append(_best_of_group(group))
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


def assign_ids(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assigns a stable "c0000"-style string `id` to each candidate, in list
    order -- called after group_recurring(), the only point the final
    ordered candidate list exists (both collapse_exact_duplicates and
    group_recurring keep explicit order, so this is deterministic run to
    run). String, not int: event_parsers/base.py's Event type is
    dict[str, str]. This id is what Selection's annotations and
    merge_selections.py key off of instead of re-matching on title text."""
    result = []
    for i, candidate in enumerate(candidates):
        annotated = dict(candidate)
        annotated["id"] = f"c{i:04d}"
        result.append(annotated)
    return result


def cap_descriptions(candidates: list[dict[str, Any]], limit: int = DESCRIPTION_CAP) -> list[dict[str, Any]]:
    """Truncates each candidate's `description` to `limit` chars with a
    trailing ellipsis, applied last (after any sold-out note prefix has
    already been added by collapse_exact_duplicates) since this is purely
    an emit-time size control, not a data transform."""
    result = []
    for candidate in candidates:
        description = candidate.get("description") or ""
        if len(description) <= limit:
            result.append(candidate)
            continue
        capped = dict(candidate)
        capped["description"] = description[:limit].rstrip() + "…"
        result.append(capped)
    return result


def split_by_day(result: dict[str, Any], week_dir: Path) -> list[Path]:
    """Writes one candidate file per date in the target week (Monday through
    Sunday) to <week_dir>/_candidates/<date>.json, so a Selection day-agent
    reads ~7-20k tokens instead of the whole week's ~86k. A recurring
    candidate (already collapsed to its earliest occurrence by
    group_recurring) lands only in that representative date's file -- same
    as it appears only once in the monolithic file. All 7 dates get a file
    even if empty, so a day-agent's "no candidates" case is a real, present
    file rather than a missing one. check_yield.py's orphan check globs
    week_dir non-recursively (week_dir.glob("*.json")), so this subdirectory
    is invisible to it -- verified, not assumed.

    Raises if any candidate's date falls outside the Monday-Sunday window --
    per-day files are Selection's only input once --split-by-day is used, so
    a candidate that doesn't land in any of the 7 buckets would otherwise
    vanish from the report with no trace, the exact silent-drop failure
    class this project designs against elsewhere (check_yield.py, and
    merge_selections.py's own fail-loud rules)."""
    monday = date.fromisoformat(result["week"])
    week = common.week_dates(monday)
    valid_dates = {d.isoformat() for d in week}
    by_date: dict[str, list[dict[str, Any]]] = {d: [] for d in valid_dates}
    out_of_window = [c for c in result["candidates"] if c.get("date", "") not in valid_dates]
    if out_of_window:
        described = ", ".join(f"{c.get('id', '?')} ({c.get('title', '?')!r}, date={c.get('date', '?')!r})" for c in out_of_window)
        raise ValueError(
            f"{len(out_of_window)} candidate(s) fall outside the target week "
            f"{week[0].isoformat()}..{week[-1].isoformat()} and would be silently dropped: {described}"
        )
    for candidate in result["candidates"]:
        by_date[candidate["date"]].append(candidate)

    out_dir = week_dir / "_candidates"
    out_dir.mkdir(exist_ok=True)
    paths = []
    for day in week:
        day_str = day.isoformat()
        payload = {
            "week": result["week"],
            "date": day_str,
            "collection_failures": result["collection_failures"],
            "candidates": by_date[day_str],
        }
        path = out_dir / f"{day_str}.json"
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        paths.append(path)
    return paths


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
    # Before group_recurring, so recurrence counts see one record per event
    # rather than one per source.
    deduped = collapse_cross_source_duplicates(deduped)
    grouped = group_recurring(deduped)
    identified = assign_ids(grouped)
    capped = cap_descriptions(identified)
    return {
        "week": manifest.get("week", week_dir.name),
        "collection_failures": collection_failures(manifest),
        "raw_event_count": len(raw_events),
        "candidates": capped,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Flatten, dedupe, and annotate a week's Collection output for Selection")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--out", type=Path, default=None, help="Defaults to <week_dir>/_candidates.json")
    parser.add_argument(
        "--split-by-day",
        action="store_true",
        help="Also write <week_dir>/_candidates/<date>.json, one per day, for per-day Selection agents",
    )
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

    if args.split_by_day:
        day_paths = split_by_day(result, args.week_dir)
        print(f"Split into {len(day_paths)} per-day file(s) under {args.week_dir / '_candidates'}", file=sys.stderr)


if __name__ == "__main__":
    main()
