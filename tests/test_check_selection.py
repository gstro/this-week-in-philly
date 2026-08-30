"""Tests for scripts/check_selection.py.

All fixtures are small inline dicts shaped like a merged _selections.json --
the check functions are pure functions over already-parsed JSON, matching
tests/test_merge_selections.py's precedent.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from check_selection import (
    check_cost_not_blank,
    check_implausible_start_time,
    check_outside_philadelphia,
    check_repeat_of_recent_pick,
    check_same_series,
    check_time_format,
    check_venue_cap,
    collect_issues,
    load_recent_weeks,
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
    assert "123chestnutst" in issues[0].message


def test_venue_cap_collapses_punctuation_variants_of_the_same_address() -> None:
    """Regression test for the real 2026-08-03 miss: Iffy Books took 5 of 21
    top3 slots that week, but the address was spelled three different ways
    across the picks ("404 S. 20th St.,", "404 S. 20th St,", "404 S 20th
    St,"), which split what should have been one venue key into two and let
    the cap pass silently. The key must collapse punctuation/whitespace
    variants onto a single venue."""
    picks = [
        _pick("A", address="404 S. 20th St., Philadelphia, PA 19146"),
        _pick("B", address="404 S. 20th St, Philadelphia, PA 19146"),
        _pick("C", address="404 S 20th St, Philadelphia, PA 19146"),
    ]
    selections = _selections([_day("2026-08-03", top3=picks)])
    issues = check_venue_cap(selections)
    assert len(issues) == 1


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
    assert "iffybooks" in issues[0].message


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
    assert issues[0].severity == "fail"


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
    assert issues[0].severity == "fail"


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


# --- outside philadelphia ---


def test_outside_philadelphia_flags_a_different_municipality() -> None:
    selections = _selections([_day("2026-08-10", top3=[_pick("A", address="100 Station Ave, Oaks, PA 19456")])])
    issues = check_outside_philadelphia(selections)
    assert len(issues) == 1
    assert issues[0].severity == "warn"


def test_outside_philadelphia_does_not_flag_a_philadelphia_address() -> None:
    selections = _selections([_day("2026-08-10", top3=[_pick("A", address="531 N 12th St, Philadelphia, PA 19123")])])
    assert check_outside_philadelphia(selections) == []


def test_outside_philadelphia_skips_a_pick_with_no_address() -> None:
    """A pick with no address at all (e.g. 2026-08-03's 'The Dell Music
    Center', keyed on venue name only) has no municipality to check --
    treating "no address" as "not Philadelphia" would false-positive here."""
    selections = _selections([_day("2026-08-03", top3=[_pick("A", venue="The Dell Music Center")])])
    assert check_outside_philadelphia(selections) == []


# --- repeat of a recent pick ---


def test_repeat_pick_flags_the_same_event_in_a_prior_week() -> None:
    prior = _selections([_day("2026-08-10", top3=[_pick("Killer Of Sheep", venue="Philadelphia Film Society")])], week="2026-08-10")
    current = _selections([_day("2026-08-20", top3=[_pick("Killer Of Sheep", venue="Philadelphia Film Society")])], week="2026-08-17")
    issues = check_repeat_of_recent_pick(current, [prior])
    assert len(issues) == 1
    assert issues[0].severity == "warn"
    assert "2026-08-10" in issues[0].message


def test_repeat_pick_matches_across_an_inconsistent_model_written_address() -> None:
    """Regression for the real West Philly canvass case: three consecutive
    weeks at one venue string, but Selection wrote a different `address` each
    time (and none at all the third week). Keying on `address` the way
    check_venue_cap does silently missed two of the three repeats, which is
    why _repeat_key uses the source-derived venue name instead."""
    prior = _selections(
        [_day("2026-08-12", top3=[_pick("West Philly Canvass", venue="Kingsessing Recreation Center", address="5140 Chester Ave, Philadelphia, PA 19143")])],
        week="2026-08-10",
    )
    current = _selections(
        [_day("2026-08-19", top3=[_pick("West Philly Canvass", venue="Kingsessing Recreation Center", address="4901 Kingsessing Ave, Philadelphia, PA 19143")])],
        week="2026-08-17",
    )
    assert len(check_repeat_of_recent_pick(current, [prior])) == 1


def test_repeat_pick_normalizes_an_emoji_prefixed_title() -> None:
    """2026-08-17 titled it '🔋 Beginner Soldering: Li-Ion Battery Pack';
    2026-08-03 used the plain title. Same event."""
    prior = _selections([_day("2026-08-06", top3=[_pick("Beginner Soldering: Li-Ion Battery Pack", venue="Iffy Books")])], week="2026-08-03")
    current = _selections([_day("2026-08-20", top3=[_pick("\U0001f50b Beginner Soldering: Li-Ion Battery Pack", venue="Iffy Books")])], week="2026-08-17")
    assert len(check_repeat_of_recent_pick(current, [prior])) == 1


def test_repeat_pick_does_not_flag_the_same_title_at_a_different_venue() -> None:
    prior = _selections([_day("2026-08-10", top3=[_pick("Open Mic", venue="Tattooed Mom")])], week="2026-08-10")
    current = _selections([_day("2026-08-17", top3=[_pick("Open Mic", venue="Ortlieb's")])], week="2026-08-17")
    assert check_repeat_of_recent_pick(current, [prior]) == []


def test_repeat_pick_does_not_flag_a_new_instalment_of_a_series() -> None:
    """Out of scope by design: Dekalog Parts 1&2 -> 3&4 is genuinely
    different content, unlike the same film shown twice."""
    prior = _selections([_day("2026-08-12", top3=[_pick("Dekalog: Parts 1 & 2", venue="Philadelphia Film Society")])], week="2026-08-10")
    current = _selections([_day("2026-08-19", top3=[_pick("Dekalog: Parts 3 & 4", venue="Philadelphia Film Society")])], week="2026-08-17")
    assert check_repeat_of_recent_pick(current, [prior]) == []


def test_repeat_pick_reports_every_prior_week_it_appeared_in() -> None:
    priors = [
        _selections([_day("2026-08-04", top3=[_pick("Reading Group", venue="Ethical Society")])], week="2026-08-03"),
        _selections([_day("2026-08-11", top3=[_pick("Reading Group", venue="Ethical Society")])], week="2026-08-10"),
    ]
    current = _selections([_day("2026-08-18", top3=[_pick("Reading Group", venue="Ethical Society")])], week="2026-08-17")
    issues = check_repeat_of_recent_pick(current, priors)
    assert len(issues) == 1
    assert "2026-08-03" in issues[0].message
    assert "2026-08-10" in issues[0].message


def test_repeat_pick_is_silent_with_no_prior_weeks() -> None:
    """The earliest week in the repo, and the no-sidecar/no-history case."""
    current = _selections([_day("2026-08-17", top3=[_pick("Anything")])])
    assert check_repeat_of_recent_pick(current, []) == []
    assert check_repeat_of_recent_pick(current, None) == []


# --- load_recent_weeks (the one check that touches disk) ---


def _week_on_disk(root, name: str, *, with_selections: bool = True) -> None:  # noqa: ANN001
    d = root / name
    d.mkdir()
    if with_selections:
        (d / "_selections.json").write_text(json.dumps(_selections([_day(name)], week=name)))


def test_load_recent_weeks_returns_the_most_recent_priors_newest_first(tmp_path) -> None:  # noqa: ANN001
    for name in ("2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"):
        _week_on_disk(tmp_path, name)
    weeks = load_recent_weeks(tmp_path / "2026-08-24", lookback=2)
    assert [w["week"] for w in weeks] == ["2026-08-17", "2026-08-10"]


def test_load_recent_weeks_skips_collection_only_weeks(tmp_path) -> None:  # noqa: ANN001
    """data/2026-07-20 and -07-27 are real Collection-only dirs with no
    _selections.json. They must be stepped over, not counted or crashed on."""
    _week_on_disk(tmp_path, "2026-07-13")
    _week_on_disk(tmp_path, "2026-07-20", with_selections=False)
    _week_on_disk(tmp_path, "2026-07-27", with_selections=False)
    _week_on_disk(tmp_path, "2026-08-03")
    weeks = load_recent_weeks(tmp_path / "2026-08-03", lookback=3)
    assert [w["week"] for w in weeks] == ["2026-07-13"]


def test_load_recent_weeks_returns_empty_for_the_earliest_week(tmp_path) -> None:  # noqa: ANN001
    _week_on_disk(tmp_path, "2026-06-22")
    assert load_recent_weeks(tmp_path / "2026-06-22") == []


def test_load_recent_weeks_never_looks_forward(tmp_path) -> None:  # noqa: ANN001
    _week_on_disk(tmp_path, "2026-08-17")
    _week_on_disk(tmp_path, "2026-08-24")
    assert load_recent_weeks(tmp_path / "2026-08-17") == []


# --- collect_issues ---


def test_collect_issues_omits_the_repeat_check_when_no_priors_are_passed() -> None:
    """collect_issues' prior_weeks argument is optional so every existing
    caller keeps working; the cross-week check just produces nothing."""
    selections = _selections([_day("2026-08-17", top3=[_pick("A")])])
    assert "repeat_pick" not in {i.check for i in collect_issues(selections)}


def test_collect_issues_includes_the_repeat_check_when_priors_are_passed() -> None:
    prior = _selections([_day("2026-08-10", top3=[_pick("A")])], week="2026-08-10")
    selections = _selections([_day("2026-08-17", top3=[_pick("A")])])
    assert "repeat_pick" in {i.check for i in collect_issues(selections, [prior])}


def test_collect_issues_aggregates_all_checks() -> None:
    picks = [_pick("A", address="123 Chestnut St", time="7:00, 7:30", cost="")]
    selections = _selections([_day("2026-08-03", top3=picks)])
    issues = collect_issues(selections)
    checks = {i.check for i in issues}
    assert "time_format" in checks
    assert "cost_blank" in checks
    # implausible_time is suppressed because time_format already caught this malformed time
    assert "implausible_time" not in checks
