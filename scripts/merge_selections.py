#!/usr/bin/env python3
"""Deterministic merge: _candidates.json + Selection's _selection_annotations.json
-> _selections.json, in exactly the schema Presentation's four consumer scripts
(html_render.py, calendar_create.py, spotify_lookup.py, csv_log.py) already expect.

Runs as presentation.yml's first step, before scripts/runner.sh -- not as its
own push-triggered workflow. A separate workflow that merged and pushed
_selections.json would push with the default GITHUB_TOKEN, which does not
retrigger `on: push`; presentation.yml would then never fire for that push,
same constraint that already forced check_yield.py inline into
collection.yml and prepare_selection_input.py inline as well. Selection
itself pushes _selection_annotations.json with ambient user auth, so
presentation.yml's `on: push` trigger fires for that push -- see the trigger
repoint in presentation.yml.

Why a merge step exists at all, rather than Selection writing _selections.json
directly: Selection re-transcribing title/venue/time/cost/url/source data it
was just handed in _candidates.json cost ~32k output tokens per run for no
reason -- see the token-optimization plan. Selection now writes only the
judgment calls (category, sold_out, note, why, rank, is_music) keyed by a
candidate's stable `id`; this script reconstructs the rest verbatim.

Two consequences of resolving by id instead of Selection re-typing title/venue:

1. It closes a real drift bug: on the real 2026-08-03 week, 62 of 562 events
   in _selections.json did not join back to any candidate by exact title
   string (Selection had silently reworded some titles). html_render.py's
   star (top3) marking and Spotify/calendar lookups all key off exact title
   match -- resolving top3/honorable_mentions/events from the same candidate
   id guarantees the title used everywhere is the one that already round-trips.
2. It requires every id Selection references to actually resolve, appear on
   the day it's placed under, and (for top3/honorable_mentions) also appear
   in that day's own annotations list -- so the event shows up in `events[]`
   with its full card. A merge that silently dropped a referenced event
   would be the same failure class check_yield.py already guards against
   for raw Collection data; this script raises instead.

events[] order is not cosmetic: html_render.py's build_categories() sorts by
parsed time with the original array index as the final tie-break, and (an
unwired but still-live) csv_log.py's honorable-mention lookup resolves ties
by earliest array position. This script emits events[] pre-ordered by
common.CATEGORY_ORDER, then chronologically within category, with ties
broken by each candidate's original position in _candidates.json -- fully
reproducible regardless of what order Selection's annotations happen to be
written in.

`is_music` is written on top3 picks only, not on events[] -- confirmed by
grepping every consumer (scripts/ and templates/): only pick/top3 objects
are ever read for is_music (html_render.py's Spotify-link lookup,
spotify_lookup.py's batch lookup, csv_log.py's spotify_link column). No
consumer reads it off an events[] entry, so omitting it there is a schema
simplification with zero behavior change, not a feature cut.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from datetime import time as dt_time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common


class MergeError(Exception):
    """Raised for any of the fail-loud conditions below. Caught once, in
    main(), and reported as a single clean message -- never a condition
    this script silently works around, since a merge that quietly drops or
    misfiles a referenced event is the exact failure class it exists to
    prevent."""


def _candidate_lookup(candidates_doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidates_doc["candidates"]:
        by_id[candidate["id"]] = candidate
    return by_id


def _resolve_candidate(candidate_id: str, day_date: str, candidates_by_id: dict[str, dict[str, Any]], context: str) -> dict[str, Any]:
    candidate = candidates_by_id.get(candidate_id)
    if candidate is None:
        raise MergeError(f"{context}: id {candidate_id!r} does not match any candidate in _candidates.json")
    if candidate.get("date") != day_date:
        raise MergeError(
            f"{context}: id {candidate_id!r} ({candidate.get('title')!r}) belongs to "
            f"{candidate.get('date')!r}, not the day it was placed under ({day_date!r})"
        )
    return candidate


def _require_in_annotations(candidate_id: str, ann_by_id: dict[str, dict[str, Any]], day_date: str, kind: str) -> None:
    """top3 and honorable_mentions ids must also appear in that day's own
    `annotations` list -- otherwise the pick/mention would have no entry in
    events[], which is where consumers (html_render.py's category listing,
    csv_log.py's honorable-mention lookup) get its category/source/cost/note."""
    if candidate_id not in ann_by_id:
        raise MergeError(f"{day_date}: {kind} id {candidate_id!r} is not present in this day's annotations -- it would be missing from events[]")


def build_top3(day: dict[str, Any], candidates_by_id: dict[str, dict[str, Any]], ann_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    day_date = day["date"]
    result = []
    for pick in day.get("top3", []):
        candidate_id = pick["id"]
        candidate = _resolve_candidate(candidate_id, day_date, candidates_by_id, f"{day_date} top3")
        _require_in_annotations(candidate_id, ann_by_id, day_date, "top3")
        for field in ("category", "is_music", "sold_out", "why", "rank"):
            if field not in pick:
                raise MergeError(f"{day_date} top3 id {candidate_id!r}: annotation missing required field {field!r}")
        entry = {
            "rank": pick["rank"],
            "title": candidate.get("title", ""),
            "venue": candidate.get("venue", ""),
            **({"address": pick["address"]} if pick.get("address") else {}),
            "time": candidate.get("time", ""),
            "cost": candidate.get("cost", ""),
            "url": candidate.get("url", ""),
            "category": pick["category"],
            "source": candidate.get("source", ""),
            "is_music": pick["is_music"],
            "sold_out": pick["sold_out"],
            "why": pick["why"],
        }
        result.append(entry)
    return result


def build_honorable_mentions(day: dict[str, Any], candidates_by_id: dict[str, dict[str, Any]], ann_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    day_date = day["date"]
    result = []
    for mention in day.get("honorable_mentions", []):
        candidate_id = mention["id"]
        candidate = _resolve_candidate(candidate_id, day_date, candidates_by_id, f"{day_date} honorable_mentions")
        _require_in_annotations(candidate_id, ann_by_id, day_date, "honorable_mentions")
        result.append({"title": candidate["title"], "venue": candidate["venue"]})
    return result


def _parse_time_for_sort(event_time: str) -> dt_time | None:
    try:
        return datetime.strptime(event_time, "%I:%M %p").time()  # noqa: DTZ007 -- .time() only, matches html_render.py's own tie-break
    except (ValueError, TypeError):
        return None


def build_events(
    day: dict[str, Any],
    candidates_doc: dict[str, Any],
    candidates_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    day_date = day["date"]
    ann_by_id = {a["id"]: a for a in day.get("annotations", [])}
    for candidate_id, ann in ann_by_id.items():
        for field in ("category", "sold_out"):
            if field not in ann:
                raise MergeError(f"{day_date} annotation id {candidate_id!r}: missing required field {field!r}")
        if ann["category"] not in common.CATEGORY_ORDER:
            raise MergeError(f"{day_date} annotation id {candidate_id!r}: category {ann['category']!r} is not one of the nine canonical categories")

    events = []
    # Iterate candidates in their original _candidates.json order (not
    # ann_by_id's dict order) so ties in the sort below break on a fixed,
    # reproducible position rather than whatever order Selection happened
    # to write annotations in.
    for candidate in candidates_doc["candidates"]:
        candidate_id = candidate.get("id")
        ann = ann_by_id.get(candidate_id)
        if ann is None:
            continue
        if candidate.get("date") != day_date:
            raise MergeError(f"{day_date} annotation id {candidate_id!r} ({candidate.get('title')!r}) belongs to {candidate.get('date')!r}, not {day_date!r}")
        entry = {
            "title": candidate.get("title", ""),
            "venue": candidate.get("venue", ""),
            "time": candidate.get("time", ""),
            "cost": candidate.get("cost", ""),
            "url": candidate.get("url", ""),
            "category": ann["category"],
            "source": candidate.get("source", ""),
            "sold_out": ann["sold_out"],
            **({"note": ann["note"]} if ann.get("note") else {}),
        }
        events.append(entry)

    events.sort(
        key=lambda e: (
            common.CATEGORY_ORDER.index(e["category"]),
            _parse_time_for_sort(e.get("time", "")) is None,
            _parse_time_for_sort(e.get("time", "")) or dt_time.min,
        )
    )
    return events


def merge_day(day: dict[str, Any], candidates_doc: dict[str, Any], candidates_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    ann_by_id = {a["id"]: a for a in day.get("annotations", [])}
    return {
        "date": day["date"],
        "day_name": day["day_name"],
        "top3": build_top3(day, candidates_by_id, ann_by_id),
        "honorable_mentions": build_honorable_mentions(day, candidates_by_id, ann_by_id),
        "events": build_events(day, candidates_doc, candidates_by_id),
    }


def merge(candidates_doc: dict[str, Any], annotations_doc: dict[str, Any]) -> dict[str, Any]:
    candidates_by_id = _candidate_lookup(candidates_doc)
    return {
        "week": annotations_doc["week"],
        "total_events_after_dedup": len(candidates_doc["candidates"]),
        "collection_failures": annotations_doc.get("collection_failures", candidates_doc.get("collection_failures", [])),
        "days": [merge_day(day, candidates_doc, candidates_by_id) for day in annotations_doc["days"]],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge _candidates.json + _selection_annotations.json into _selections.json")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--out", type=Path, default=None, help="Defaults to <week_dir>/_selections.json")
    args = parser.parse_args()

    candidates_doc = common.load_json(args.week_dir / "_candidates.json")
    annotations_doc = common.load_json(args.week_dir / "_selection_annotations.json")

    try:
        result = merge(candidates_doc, annotations_doc)
    except MergeError as exc:
        print(f"merge_selections: {exc}", file=sys.stderr)
        sys.exit(1)

    out_path = args.out or (args.week_dir / "_selections.json")
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")

    total_top3 = sum(len(day["top3"]) for day in result["days"])
    total_events = sum(len(day["events"]) for day in result["days"])
    print(
        f"Merge complete. {len(result['days'])} day(s), {total_top3} top3 pick(s), "
        f"{total_events} listed event(s). Written to {out_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
