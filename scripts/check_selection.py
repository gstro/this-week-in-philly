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

Every check below started life as WARN (per PR #25's review) "until we're
confident they are tuned appropriately." Two have since run against a real
week and earned promotion; the rest have not. Per-check status:
  - cost_blank: FAIL. Promoted once merge_selections.py's "Not listed"
    default landed (7540385) -- 93 warnings on 2026-08-03, 67 on 2026-08-10,
    0 on 2026-08-17. Note the honest reading of that trend: post-merge, cost
    can no longer BE blank (merge_selections.py always fills it), so this is
    a regression guard on that default, not a judgment call that "ran
    clean." Still promotable on that basis -- if it ever fires, the default
    itself broke.
  - time_format: FAIL. WARN is exactly why a malformed time shipped and
    published on 2026-08-17 (see the check's own docstring entry below) --
    the false-positive risk this severity model exists to protect against
    isn't the failure mode that occurred; a false negative was. Once
    merge_selections.py also rejects a bad time at merge time (see its
    docstring), this check becomes unreachable in the normal pipeline --
    kept anyway as the unit-tested regression guard and as a backstop for
    any path that writes _selections.json without going through the merge.
  - venue_cap: WARN permanently -- a decision, not a pending promotion, and
    the tranches that kept deferring it were asking the wrong question. Over
    all 126 published top3 slots, Iffy Books took 16, PhilaMOCA 14 and Wooden
    Shoe 13: three venues, 34% of every slot ever published. Greg's call is
    that this is fine when the events are good, and those three are an
    anarchist bookstore, a DIY cinema and a radical bookshop -- Core-tier
    interests per personal-interests. A venue is not a proxy for event
    quality in either direction, so no threshold should fail a build over
    one. What replaces the cap as a control is a softly-worded nudge at
    Selection time (philly-events-selection/SKILL.md's Phase 3), where the
    question "am I leaning on one room this week?" can be weighed against
    the actual events. This check's job is drift detection only: it reports
    what happened and names the venues pooled under each key. Do not promote
    it; do not reintroduce a number in the prose either.
  - implausible_time, same_series: WARN by design -- both have plausible
    legitimate exceptions (a real late show; two workshops that share a
    title prefix by coincidence).
  - outside_philadelphia, repeat_pick, missing_address, address_conflict:
    WARN by design. Each surfaces a judgement call with legitimate
    exceptions -- a genuinely worth-the-trip suburban show, a repeat with a
    real reason, an online event with no address, a case where Selection's
    address beat the source's (2026-08-10's Keswick screening is the one
    recorded instance).

Checks:
  1. Venue cap (WARN) -- reports when more than VENUE_CAP top3 slots in a
     week land at one venue. Keyed by _venue_key(): the source's structured
     `venue_address` first, then Selection's `address`, then a normalized
     venue-name prefix. _street_key() folds abbreviation and ZIP variants, so
     "1412 Chestnut St" and "1412 Chestnut Street" are one venue. Advisory --
     see the per-check status above for why this stays WARN.
  2. Time format (FAIL) -- regression guard for the defect fixed in
     9bbd592: every top3 pick's `time` must be a single `%I:%M %p` string,
     never a list, a doors/show pair, or a range. A malformed time means
     calendar_create.py's parse_start() silently never creates that pick's
     calendar entry -- confirmed on 5 of 21 real 2026-08-03 picks before the
     fix, and recurred on 2026-08-17 (two picks whose annotations omitted a
     `time` override, so the merge fell through to the candidate's dirty
     raw value) after the fix landed but while this check was still WARN.
  3. Cost not blank (FAIL) -- regression guard for merge_selections.py's
     "Not listed" default (see its docstring): an empty cost string
     reaching _selections.json means that default was bypassed somehow.
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
  6. Outside Philadelphia (WARN) -- event-selection-philosophy's Data
     Plausibility Checklist names this rule; nothing previously enforced
     it. 2026-08-10 shipped two Top 3 picks outside city limits (Glenside,
     PA and Oaks, PA, ~25 mi). Per Greg's call, out-of-city is allowed at a
     high bar, not blocked -- so this stays WARN, flagged for review, not
     failed. Skips picks with no `address` at all (falls back to a venue
     name, which carries no municipality to check) rather than treating a
     missing address as "not Philadelphia."
  7. Repeat pick (WARN) -- a top3 pick that already held a top3 slot in one
     of the RECENT_WEEKS_LOOKBACK prior weeks with selections. See
     check_repeat_of_recent_pick().
  8. Missing address (WARN) -- a top3 pick with no address from either the
     source or Selection: no Calendar location, and a degenerate cap key.
  9. Address conflict (WARN) -- the source's structured venue address and
     Selection's disagree. merge_selections.py prefers the source's; this is
     what makes that precedence auditable.

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
import unicodedata
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


_NON_ALNUM_RE = re.compile(r"[^a-z0-9]")


def normalize_venue(venue: str) -> str:
    """Fallback key for the venue cap when a pick has no `address` -- the
    text before the first comma, lowercased. Matches
    event-selection-philosophy/SKILL.md's Weekly Caps fallback rule."""
    return venue.split(",")[0].strip().lower()


# Whole-token synonyms, applied before the alphanumeric strip. Selection
# authors addresses free-hand and spells the same one several ways across
# weeks; without this, one venue mints several keys.
_ADDRESS_SYNONYMS = {
    "street": "st", "str": "st", "avenue": "ave", "av": "ave", "boulevard": "blvd",
    "road": "rd", "drive": "dr", "place": "pl", "court": "ct", "lane": "ln",
    "square": "sq", "terrace": "ter", "parkway": "pkwy", "highway": "hwy",
    "circle": "cir", "saint": "st",
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
}
_UNIT_NOISE = frozenset({"suite", "ste", "unit", "apt", "floor", "fl", "rear", "bldg", "usa", "us"})
_ZIP_RE = re.compile(r"^\d{5}(-\d{4})?$")


def _street_key(text: str) -> str:
    """Normalize one address string to a comparable street key.

    Deliberately discards locality (city/state/ZIP) and unit noise, keeping
    only house number + street. That is what makes the key comparable ACROSS
    SOURCES, which is the property the whole venue cap rests on: PhilaMOCA
    reaches top3 via its own source AND via Do215 in the same week (2026-06-22,
    2026-08-03), and Do215 supplies a bare "531 N 12th St" where Selection
    writes "531 N 12th St, Philadelphia, PA 19123". Keying on the full string
    would split one venue in two.

    The cost is that two identical house-number+street pairs in different
    municipalities would pool. Zero occurrences across 51 real top3 addresses,
    and check_outside_philadelphia() surfaces non-Philly picks independently.

    Guiding asymmetry, since several calls here are judgement: a false SPLIT
    fails open (a venue is under-counted, the report still ships) while a false
    MERGE fails closed (a warning about venues that aren't the same room).
    Resolve anything ambiguous toward splitting.
    """
    cleaned = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    # Take the text before the first comma only when it starts with a house
    # number -- that is what makes a bare source address ("1200 Callowhill St")
    # comparable with Selection's fuller one, and what defuses Do215's doubled
    # full_address shape ("304 South St, Philadelphia, PA 19147, Philadelphia,
    # PA, 19147").
    head = cleaned.split(",")[0].strip()
    if head and head[0].isdigit():
        cleaned = head
    tokens = [t for t in re.split(r"[^A-Za-z0-9]+", cleaned.lower()) if t]
    out = [
        _ADDRESS_SYNONYMS.get(t, t)
        for t in tokens
        if not _ZIP_RE.match(t) and t not in _UNIT_NOISE
    ]
    return "".join(out)


def _venue_key(pick: dict) -> str:
    """Cap key for a pick: the source's venue address, else Selection's
    `address`, else a normalized venue-name prefix.

    Selection authors `address` free-hand and spells one venue several ways.
    An earlier version stripped everything but letters and digits, which fixed
    punctuation ("404 S. 20th St.," / "404 S 20th St,", the 2026-08-03 Iffy
    Books case that split 5 slots into 4+1) but not abbreviations or ZIP drift.
    That version's docstring claimed it had been "verified against all 33
    distinct top3 addresses to produce exactly one collapse and no others";
    that claim is now false -- see the false merge below.

    _street_key adds whole-token synonyms and drops ZIPs. Verified over every
    committed week: across all 126 published top3 picks, 57 keys -> 52; across
    the 51 distinct top3 ADDRESS strings, 51 -> 44. Exactly seven groups merge
    and every one is a real venue that was previously double-counted:
      Iffy Books        three punctuation variants of 404 S 20th St
      PFS               1412 Chestnut St / 1412 Chestnut Street
      Ortlieb's         847 N 3rd St / 847 North 3rd Street
      Johnny Brenda's   1201 N / 1201 North Frankford Ave
      Underground Arts  1200 Callowhill St under ZIPs 19107 and 19123
      Cousin Danny's    5001 Market St with and without a ZIP
      Pentridge Station venue-name fallback, with and without the city
    Zero false merges. "847 N 3rd St" and "847 N Franklin St" stay distinct --
    same house number, different street -- the case the old docstring worried
    about.

    Source address first is what fixes a real false merge: on 2026-08-31
    Selection authored "301 S Christopher Columbus Blvd" for BOTH Spruce Street
    Harbor and Cherry Street Pier, pooling two different venues under one key
    (and pinning a calendar entry a mile off -- Do215 puts Cherry Street Pier
    at 121 N). See merge_selections.py's build_top3 for the full precedence
    argument.

    One known and accepted false merge remains: Moshulu and Spirit of
    Philadelphia are two different boats at 401 S Columbus Blvd. Under a
    locality-stripped street key 5 of 108 Do215 venue keys pool distinct venue
    ids, and the other 4 are genuine repairs (FringeArts/FRINGE BAR, Perelman
    inside Kimmel, and two pairs of duplicate venue records). Documented rather
    than engineered around: venue_cap is a WARN, so it costs a line of output.
    """
    for source_field in ("venue_address", "address"):
        value = pick.get(source_field)
        if value and value.strip():
            return _street_key(value)
    return _NON_ALNUM_RE.sub("", normalize_venue(pick.get("venue", "")))


def _repeat_key(pick: dict) -> tuple[str, str]:
    """Identity of an event for cross-week repeat detection: normalized title
    plus normalized *venue name*.

    Deliberately NOT _venue_key(). That prefers `address`, which Selection
    writes from its own memory and spells inconsistently across weeks: the
    West Philly canvass at Kingsessing Recreation Center took a top3 slot in
    three consecutive weeks under one identical venue string but three
    different addresses ("5140 Chester Ave...", "4901 Kingsessing Ave...",
    and none at all), so an address key silently missed two of the three
    repeats. `venue` comes from the source and is stable week to week, which
    is what a cross-week comparison needs. (Within one week the tradeoff runs
    the other way, which is why check_venue_cap still keys on address.)

    Stripping non-alphanumerics also makes 2026-08-17's "\U0001f50b Beginner
    Soldering: Li-Ion Battery Pack" match 2026-08-03's plain "Beginner
    Soldering: Li-Ion Battery Pack".
    """
    title = _NON_ALNUM_RE.sub("", pick.get("title", "").casefold())
    venue = _NON_ALNUM_RE.sub("", normalize_venue(pick.get("venue", "")))
    return (title, venue)


def check_repeat_of_recent_pick(selections: dict, prior_weeks: list[dict] | None = None) -> list[Issue]:
    """WARN: a top3 pick that already held a top3 slot in a recent week.

    event-selection-philosophy's Avoid list already says "Recurring weekly
    events as a Top 3 pick unless there's a special guest or specific reason
    to highlight this instance" -- but nothing had ever looked at a prior
    week, so the rule was unenforceable in the direction that matters.
    Measured across the five weeks with committed selections, 5-24% of top3
    slots each week were content that already ran in an earlier report:
    "Rustin's Challenge Reading Group" took a slot in four consecutive
    reports, the West Philly canvass three, "Killer Of Sheep" two.

    prepare_selection_input.py's group_recurring() cannot catch this -- it
    collapses the same (title, venue) on 3+ dates *within one week*, and a
    weekly event appears exactly once per week, so recurrence_count is empty
    for every one of those picks.

    Scope is deliberately narrow: only an exact repeat of the same event at
    the same venue. A new instalment of a series (Dekalog Parts 1&2 -> 3&4)
    is genuinely different content and is not flagged.

    WARN, not FAIL: a repeat can be legitimate (a special guest, a notable
    second run). Note this check runs after Selection has already written its
    annotations, so it detects drift for the following week rather than
    preventing the repeat -- philly-events-selection/SKILL.md's Phase 3 step
    is the actual control.
    """
    issues: list[Issue] = []
    seen: dict[tuple[str, str], list[str]] = {}
    for prior in prior_weeks or []:
        week = prior.get("week", "?")
        for _day_date, pick in _iter_top3(prior):
            seen.setdefault(_repeat_key(pick), []).append(week)

    for day_date, pick in _iter_top3(selections):
        weeks = seen.get(_repeat_key(pick))
        if not weeks:
            continue
        issues.append(
            Issue(
                "repeat_pick",
                "warn",
                day_date,
                pick.get("title"),
                f"already held a top3 slot in {', '.join(sorted(set(weeks)))} -- "
                f"event-selection-philosophy's Avoid rule covers recurring events across weeks, "
                f"not just within one. Drop it, or say in the `why` what makes this instance worth the slot",
            )
        )
    return issues


def check_venue_cap(selections: dict) -> list[Issue]:
    issues: list[Issue] = []
    by_venue: dict[str, list[tuple[str, dict]]] = {}
    for day_date, pick in _iter_top3(selections):
        by_venue.setdefault(_venue_key(pick), []).append((day_date, pick))

    for venue_key, picks in by_venue.items():
        if len(picks) > VENUE_CAP:
            days = ", ".join(f"{d} ({p.get('title', '?')!r})" for d, p in picks)
            # Name the venues and ids pooled under this key, so a false merge
            # (two rooms sharing a street address -- see _venue_key's Moshulu
            # note) is visible in the output instead of looking like real
            # concentration.
            pooled = sorted({p.get("venue", "?") for _, p in picks})
            ids = sorted({p["venue_id"] for _, p in picks if p.get("venue_id")})
            detail = f" [{'; '.join(pooled)}]" + (f" ids={','.join(ids)}" if ids else "")
            issues.append(
                Issue(
                    "venue_cap",
                    "warn",  # WARN permanently, by decision -- see module docstring
                    None,
                    None,
                    f"{venue_key!r} took {len(picks)} top3 slots this week: {days}{detail}",
                )
            )
    return issues


def check_missing_address(selections: dict) -> list[Issue]:
    """A top3 pick with no address at all, from either the source or Selection.

    Two consequences, both real: calendar_create.py omits `location` entirely,
    so the entry is unpinned (6 of 21 picks on 2026-08-24, all six unpinned);
    and _venue_key falls back to the venue name, which mints keys like
    'philadelphia' -- Do215's "Philadelphia, Philadelphia, Pe" string, which
    covers 11 unrelated events across four weeks and would pool them all.

    WARN, not FAIL: an online event legitimately has no address, and 2026-08-24
    is already published with six of them -- failing the build on data that
    cannot be repaired (its raw payloads aren't persisted, so backfill is
    impossible) would block a re-render for no gain.
    """
    issues = []
    for day_date, pick in _iter_top3(selections):
        if not (pick.get("address") or "").strip():
            issues.append(
                Issue(
                    "missing_address",
                    "warn",
                    day_date,
                    pick.get("title"),
                    "top3 pick has no address -- its Google Calendar entry will have no location, "
                    "and the venue cap falls back to keying on the venue name",
                )
            )
    return issues


def check_address_conflict(selections: dict) -> list[Issue]:
    """Selection's address disagrees with the source's structured one.

    merge_selections.py prefers the source's, so this is what makes that
    precedence auditable rather than silent: the one recorded case of the model
    beating the source (2026-08-10's Keswick screening) means a disagreement is
    not automatically the model being wrong.

    It is also the check that would have caught the live 2026-08-31 defect --
    Selection put Cherry Street Pier at "301 S Christopher Columbus Blvd" when
    Do215 says 121 N, pinning the calendar entry at the wrong pier.
    """
    issues = []
    for day_date, pick in _iter_top3(selections):
        source_address = (pick.get("venue_address") or "").strip()
        model_address = (pick.get("selection_address") or "").strip()
        if source_address and model_address and _street_key(source_address) != _street_key(model_address):
            issues.append(
                Issue(
                    "address_conflict",
                    "warn",
                    day_date,
                    pick.get("title"),
                    f"source says {source_address!r}, Selection wrote {model_address!r} -- "
                    f"the source's is used for the calendar pin; check which is right",
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


def check_outside_philadelphia(selections: dict) -> list[Issue]:
    """WARN-only: event-selection-philosophy's Data Plausibility Checklist
    names "a venue address outside Philadelphia" as something to verify
    before treating a candidate as eligible, but nothing previously
    enforced it -- 2026-08-10 shipped two Top 3 picks outside city limits
    (Glenside, PA and Oaks, PA, ~25 mi out). Per Greg's call, out-of-city is
    allowed at a high bar, not blocked, so this flags for review rather
    than failing. Skips picks with no `address` at all -- a missing
    address falls back to a venue-name key with no municipality to check,
    and treating "no address" as "not Philadelphia" would false-positive on
    address-less picks like 2026-08-03's "The Dell Music Center"."""
    issues: list[Issue] = []
    for day_date, pick in _iter_top3(selections):
        address = pick.get("address")
        if not address:
            continue
        if "philadelphia" not in address.lower():
            issues.append(
                Issue(
                    "outside_philadelphia",
                    "warn",
                    day_date,
                    pick.get("title"),
                    f"address {address!r} doesn't name Philadelphia -- confirm this is really "
                    f"in the city, and that the why explains the travel if it's not",
                )
            )
    return issues


RECENT_WEEKS_LOOKBACK = 3


def load_recent_weeks(week_dir: Path, lookback: int = RECENT_WEEKS_LOOKBACK) -> list[dict]:
    """The `lookback` most recent week directories before `week_dir` that
    actually contain a _selections.json.

    Counted in *directories*, not calendar weeks: data/ has real gaps
    (2026-06-22 then 2026-08-03; 2026-07-20 and -07-27 are Collection-only
    with no selections at all), so a date-window would silently reach back
    six real weeks whenever the data is sparse. Directory names are
    YYYY-MM-DD, so lexicographic order is chronological.

    This reads data/ directly and must keep doing so. It deliberately does
    NOT read _recent_picks.json: that sidecar is a token-saving convenience
    for Selection, written by a `continue-on-error: true` step in
    collection.yml, so it can legitimately be missing or stale. Two
    independent readers of the same source of truth is the point.
    """
    parent = week_dir.resolve().parent
    if not parent.is_dir():
        return []
    prior = sorted(d for d in parent.iterdir() if d.is_dir() and d.name < week_dir.resolve().name)
    weeks = []
    for d in reversed(prior):
        path = d / "_selections.json"
        if not path.is_file():
            continue  # Collection-only week, no selections to compare against
        with open(path) as f:
            weeks.append(json.load(f))
        if len(weeks) == lookback:
            break
    return weeks


def collect_issues(selections: dict, prior_weeks: list[dict] | None = None) -> list[Issue]:
    """`prior_weeks` is optional so every existing caller and test keeps
    working; the cross-week check simply produces nothing without it."""
    return [
        *check_venue_cap(selections),
        *check_time_format(selections),
        *check_cost_not_blank(selections),
        *check_implausible_start_time(selections),
        *check_same_series(selections),
        *check_outside_philadelphia(selections),
        *check_repeat_of_recent_pick(selections, prior_weeks),
        *check_missing_address(selections),
        *check_address_conflict(selections),
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

    issues = collect_issues(selections, load_recent_weeks(args.week_dir))
    week = selections.get("week", args.week_dir.name)

    print(format_report(issues, week))
    print()
    print(summarize(selections))

    if any(i.severity == "fail" for i in issues):
        sys.exit(1)


if __name__ == "__main__":
    main()
