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
judgment calls (category, sold_out, note, why, rank, is_music, address) keyed
by a candidate's stable `id`; this script reconstructs the rest verbatim. One
exception: a top3 pick MAY include an explicit `time` override, letting
Selection still clean up a candidate's genuinely messy raw time (a list, a
doors/show pair, a range) the way it always could -- see build_top3.

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

`cost` defaults to "Not listed" rather than "" when the candidate has no
price -- confirmed live on 2026-08-10: 13 of 21 top3 picks rendered a blank
cost, which is the source data faithfully passed through (Selection can no
longer write cost at all, so it can't be inventing this), but a blank card
field reads as broken rather than as "genuinely not listed." The prior
failure this same field had -- Selection inventing prices like "typical for
Wooden Shoe programming" before this refactor -- can't recur through this
path, so this default doesn't reopen it.

A top3 pick's resolved `time` (the override if one was given, else the
candidate's raw value) must parse as a single `%I:%M %p` string, or this
script raises -- confirmed live on 2026-08-17: two picks (a PhilaMOCA
double-header) omitted the `time` override, so this fell through to the
candidate's dirty raw "7:00, 7:30", which calendar_create.py's parse_start()
silently can't parse -- both picks published with no calendar entry, and
check_selection.py only caught it as a WARN, so the bad week shipped
anyway. This is the same invariant class as the required-field checks
above (a Selection omission that would otherwise silently degrade a
downstream consumer), just discovered later -- raising here, before
_selections.json is even written, means the fix is "correct the
annotation and re-run," not "notice a missing calendar entry after the
fact."
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from datetime import time as dt_time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

# Matches check_selection.py's TIME_RE -- both enforce the same "single
# clean H:MM AM/PM start time" contract from 9bbd592, at two different
# points in the pipeline (this one at merge time, that one as a
# CI-visible post-condition on the merge's own output).
_TIME_RE = re.compile(r"^\d{1,2}:\d{2} [AP]M$")


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
        # category, why, and rank have no safe default -- a missing one is a
        # real Selection bug, fail loudly. is_music/sold_out DO have a safe
        # default (false), so they're defaulted rather than required: at
        # ~350 annotated candidates a week, a model omitting an
        # occasionally-false boolean is exactly the compression that happens
        # at volume, and requiring it would fail the whole week's report
        # over a single omitted `false`.
        for field in ("category", "why", "rank"):
            if field not in pick:
                raise MergeError(f"{day_date} top3 id {candidate_id!r}: annotation missing required field {field!r}")
        # `time` normally comes verbatim from the candidate -- an explicit
        # override on the pick lets Selection still clean up a genuinely
        # messy raw time (a list, a doors/show pair, a range) into the
        # single clean start time calendar_create.py's parse_start()
        # requires, same capability the old re-typed-everything schema
        # had. Rare in practice (omitted on the overwhelming majority of
        # picks), so it costs nothing in the common case -- but when the
        # candidate's own time IS messy and no override was given, the
        # resolved value is exactly as unparseable as the raw scrape, and
        # that must fail loudly rather than silently drop the calendar
        # entry (see this module's docstring for the real 2026-08-17 case).
        resolved_time = pick.get("time", candidate.get("time", ""))
        if not _TIME_RE.match(resolved_time or ""):
            raise MergeError(
                f"{day_date} top3 id {candidate_id!r} ({candidate.get('title')!r}): resolved time "
                f"{resolved_time!r} is not a single H:MM AM/PM value -- calendar_create.py's "
                f"parse_start() would silently drop this pick's calendar entry. Set a clean `time` "
                f"override on this pick's annotation (see philly-events-selection/SKILL.md's "
                f"annotation field notes)."
            )
        # `address` becomes the Google Calendar entry's `location`
        # (calendar_create.py), so a wrong one sends you to the wrong place and
        # a missing one leaves the entry unpinned. Two candidate answers exist:
        # the source's structured venue address and Selection's, authored from
        # memory. Prefer the source's.
        #
        # That precedence is measured, not assumed. Joining a live re-fetch of
        # the 2026-08-31 week onto its committed do215.json (373/373 events
        # matched on permalink) and recomputing that week's 21 top3 venue keys
        # both ways: with Selection's address first, Spruce Street Harbor and
        # Cherry Street Pier collapse into one key at "301 S Christopher
        # Columbus Blvd" -- an address Selection invented for both, and wrong
        # for Cherry Street Pier, which Do215 puts at 121 N. With the source's
        # address first they separate correctly and the calendar entry points
        # at the right pier.
        #
        # The counter-precedent (2026-08-10, where the model overrode PhilaMOCA
        # and was right that the show was at the Keswick) does not apply: that
        # was a bad venue DISPLAY STRING from PhilaMOCA's own feed
        # self-stamping its address onto an offsite show, not a structured
        # per-event venue record. Do215 supplies the latter and has no such
        # failure mode. Deliberately not extended to philamoca.py or
        # the_rotunda.py, whose hardcoded addresses ARE that self-stamp.
        #
        # Nothing is lost silently when the model was right: check_selection.py's
        # address_conflict warns whenever the two disagree.
        resolved_address = candidate.get("venue_address") or pick.get("address") or ""
        entry = {
            "rank": pick["rank"],
            "title": candidate.get("title", ""),
            "venue": candidate.get("venue", ""),
            **({"address": resolved_address} if resolved_address else {}),
            # Carried for check_selection.py, which only ever sees
            # _selections.json -- without them it cannot compare the two
            # addresses or report which venues a cap bucket actually pooled.
            **({"venue_address": candidate["venue_address"]} if candidate.get("venue_address") else {}),
            **({"venue_id": candidate["venue_id"]} if candidate.get("venue_id") else {}),
            # Only when BOTH exist, i.e. only when there is a disagreement to
            # audit. With no source address, `address` above already is
            # Selection's and recording it twice is pure duplication.
            **(
                {"selection_address": pick["address"]}
                if pick.get("address") and candidate.get("venue_address")
                else {}
            ),
            "time": resolved_time,
            "cost": candidate.get("cost") or "Not listed",
            "url": candidate.get("url", ""),
            "category": pick["category"],
            "source": candidate.get("source", ""),
            "is_music": pick.get("is_music", False),
            "sold_out": pick.get("sold_out", False),
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
        title = candidate["title"]
        # html_render.py's build_honorable_mentions_html() bolds a literal
        # "(SOLD OUT)" suffix on the title -- restoring that requires
        # appending it here, since the title now always comes verbatim from
        # the candidate (which never carries this suffix itself). This
        # breaks the honorable-mention's exact-title match against
        # events[] (whose title has no suffix), but csv_log.py's
        # find_matching_event() already has a fuzzy-match fallback for
        # exactly this case -- its own docstring names "a (SOLD OUT) suffix
        # added" as the real, observed reason that fallback exists.
        if ann_by_id[candidate_id].get("sold_out") and not title.endswith("(SOLD OUT)"):
            title = f"{title} (SOLD OUT)"
        result.append({"title": title, "venue": candidate["venue"]})
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
        # sold_out has a safe default (false) and is deliberately not
        # required here -- see build_top3's comment on the same tradeoff.
        if "category" not in ann:
            raise MergeError(f"{day_date} annotation id {candidate_id!r}: missing required field 'category'")
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
            "cost": candidate.get("cost") or "Not listed",
            "url": candidate.get("url", ""),
            "category": ann["category"],
            "source": candidate.get("source", ""),
            "sold_out": ann.get("sold_out", False),
            **({"note": ann["note"]} if ann.get("note") else {}),
            # Recurrence, carried from the candidate so html_render.py can
            # build the "All Week / Recurring" table. group_recurring() in
            # prepare_selection_input.py has emitted these since the v2 data
            # layout landed -- they just never survived this merge, which is
            # why html_render.py's docstring long claimed _selections.json had
            # "no structured field a script could use to detect a 3+ day span"
            # and the spec'd table never rendered once in six published weeks.
            #
            # `occurrences` is ONLY the dates the series falls on inside the
            # collected week. It is not the run's real start or end and must
            # never be rendered as one -- see html_render.build_all_week.
            **({"recurrence_count": candidate["recurrence_count"]} if candidate.get("recurrence_count") else {}),
            **({"occurrences": candidate["occurrences"]} if candidate.get("occurrences") else {}),
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
    for field in ("date", "day_name"):
        if field not in day:
            raise MergeError(f"a day entry is missing required field {field!r}: {day!r}")
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

    # Added here, not inside merge(), so merge() stays a pure function of
    # its two inputs -- deterministic and easy to test. Purely informational:
    # grepped every consumer, nothing reads generated_at.
    result["generated_at"] = datetime.now().isoformat(timespec="seconds")  # noqa: DTZ005 -- informational only, matches the existing untyped local-time convention in real _selections.json files

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
