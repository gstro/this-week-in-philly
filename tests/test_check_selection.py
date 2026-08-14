"""Tests for scripts/check_selection.py.

All fixtures are small inline dicts shaped like a merged _selections.json --
the check functions are pure functions over already-parsed JSON, matching
tests/test_merge_selections.py's precedent.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from check_selection import (
    check_cost_not_blank,
    check_implausible_start_time,
    check_same_series,
    check_time_format,
    check_venue_cap,
    collect_issues,
    normalize_venue,
)

MUSIC = "\U0001f3b5 Music & Concerts"


def _pick(title: str, venue: str = "Some Venue", address: str | None = None, time: str = "7:00 PM", cost: str = "$10", category: str = MUSIC, source: str = "Some Source") -> dict:
    p = {"title": title, "venue": venue, "time": time, "cost": cost, "category": category, "source": source}
    if address:
        p["address"] = address
    return p


def _day(date: str, top3: list | None = None, events: list | None = None) -> dict:
    return {"date": date, "day_name": "Monday", "top3": top3 or [], "honorable_mentions": [], "events": events or []}


def _selections(days: list[dict], week: str = "2026-08-03") -> dict:
    return {"week": week, "days": days}


# --- venue cap ---


def test_venue_cap_not_tripped_at_exactly_the_cap() -> None:
    picks = [_pick("A", address="123 Chestnut St"), _pick("B", address="123 Chestnut St")]
    selections = _selections([_day("2026-08-03", top3=picks)])
    assert check_venue_cap(selections) == []


def test_venue_cap_tripped_over_the_cap() -> None:
    picks = [_pick("A", address="123 Chestnut St"), _pick("B", address="123 Chestnut St"), _pick("C", address="123 Chestnut St")]
    selections = _selections([_day("2026-08-03", top3=picks)])
    issues = check_venue_cap(selections)
    assert len(issues) == 1
    assert issues[0].severity == "warn"
    assert "123 chestnut st" in issues[0].message


def test_venue_cap_counts_across_the_whole_week_not_per_day() -> None:
    day1 = _day("2026-08-03", top3=[_pick("A", address="123 Chestnut St")])
    day2 = _day("2026-08-04", top3=[_pick("B", address="123 Chestnut St")])
    day3 = _day("2026-08-05", top3=[_pick("C", address="123 Chestnut St")])
    selections = _selections([day1, day2, day3])
    issues = check_venue_cap(selections)
    assert len(issues) == 1


def test_venue_cap_falls_back_to_normalized_venue_when_address_missing() -> None:
    picks = [
        _pick("A", venue="Iffy Books, 404 S. 20th St., Philadelphia, 19146, United States"),
        _pick("B", venue="Iffy Books"),
        _pick("C", venue="Iffy Books"),
    ]
    selections = _selections([_day("2026-08-03", top3=picks)])
    issues = check_venue_cap(selections)
    assert len(issues) == 1
    assert "iffy books" in issues[0].message


def test_normalize_venue_strips_address_suffix_and_lowercases() -> None:
    assert normalize_venue("Ortlieb's, Philadelphia, PA") == "ortlieb's"
    assert normalize_venue("Ortlieb's") == "ortlieb's"


# --- time format ---


def test_time_format_accepts_clean_single_time() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", time="7:00 PM")])])
    assert check_time_format(selections) == []


def test_time_format_rejects_a_range() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", time="7:00, 7:30")])])
    issues = check_time_format(selections)
    assert len(issues) == 1
    assert issues[0].severity == "warn"


def test_time_format_rejects_a_doors_show_pair() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", time="6:00 PM (doors), 7:00 PM (show)")])])
    assert len(check_time_format(selections)) == 1


# --- cost not blank ---


def test_cost_not_blank_passes_when_cost_is_present() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", cost="Not listed")])])
    assert check_cost_not_blank(selections) == []


def test_cost_not_blank_fails_on_empty_top3_cost() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", cost="")])])
    issues = check_cost_not_blank(selections)
    assert len(issues) == 1
    assert issues[0].severity == "warn"


def test_cost_not_blank_fails_on_empty_event_cost() -> None:
    selections = _selections([_day("2026-08-03", events=[{"title": "A", "cost": ""}])])
    issues = check_cost_not_blank(selections)
    assert len(issues) == 1


# --- implausible start time ---


def test_implausible_start_time_flags_midnight_as_warn() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", time="12:00 AM")])])
    issues = check_implausible_start_time(selections)
    assert len(issues) == 1
    assert issues[0].severity == "warn"


def test_implausible_start_time_does_not_flag_a_normal_evening_time() -> None:
    selections = _selections([_day("2026-08-03", top3=[_pick("A", time="7:00 PM")])])
    assert check_implausible_start_time(selections) == []


def test_implausible_start_time_skips_an_already_malformed_time() -> None:
    """check_time_format already flags this -- don't double-report it here."""
    selections = _selections([_day("2026-08-03", top3=[_pick("A", time="7:00, 7:30")])])
    assert check_implausible_start_time(selections) == []


# --- same series ---


def test_same_series_flags_shared_prefix_at_same_venue() -> None:
    picks = [
        _pick("Beginner Soldering: Li-Ion Battery Pack", venue="Iffy Books"),
        _pick("Beginner Soldering: LED Spinning Top", venue="Iffy Books"),
    ]
    selections = _selections([_day("2026-08-03", top3=[picks[0]]), _day("2026-08-04", top3=[picks[1]])])
    issues = check_same_series(selections)
    assert len(issues) == 1
    assert issues[0].severity == "warn"


def test_same_series_does_not_flag_different_venues_with_the_same_prefix() -> None:
    picks = [
        _pick("Workshop: Part One", venue="Iffy Books"),
        _pick("Workshop: Part Two", venue="Wooden Shoe Books"),
    ]
    selections = _selections([_day("2026-08-03", top3=picks)])
    assert check_same_series(selections) == []


def test_same_series_ignores_titles_with_no_separator() -> None:
    picks = [_pick("Palinoia"), _pick("Palinoia Reunion")]
    selections = _selections([_day("2026-08-03", top3=picks)])
    assert check_same_series(selections) == []


# --- collect_issues ---


def test_collect_issues_aggregates_all_checks() -> None:
    picks = [_pick("A", address="123 Chestnut St", time="7:00, 7:30", cost="")]
    selections = _selections([_day("2026-08-03", top3=picks)])
    issues = collect_issues(selections)
    checks = {i.check for i in issues}
    assert "time_format" in checks
    assert "cost_blank" in checks
    # implausible_time is suppressed because time_format already caught this malformed time
    assert "implausible_time" not in checks
