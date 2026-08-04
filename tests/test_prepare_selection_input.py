"""Tests for scripts/prepare_selection_input.py.

tests/fixtures/prepare_selection_input/sample-week/ is a small synthetic week
directory (not a real archived week) built to exercise both mechanical
transforms together: a do215-shaped 3-date recurring listing, an exact
same-source duplicate needing the completeness tiebreak, and a failed
source. tests/fixtures/check_yield/fabricated-2026-07-27/ established the
precedent of committing a whole week directory as a fixture; this one is
synthetic rather than a real incident because there's no real-incident
history for this script yet. Everything else is small inline data -- the
pure functions don't need disk I/O to exercise their logic.

The real-data validation this script actually needs (do215's real 517-event
week collapsing sensibly, no distinct event silently disappearing) is done
manually against data/2026-08-03/, not committed as a test -- see the
Selection-stage plan's Phase 5 verification.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from prepare_selection_input import (
    assign_ids,
    build_candidates,
    cap_descriptions,
    collapse_exact_duplicates,
    collection_failures,
    group_recurring,
    load_candidates_from_sources,
    load_manifest,
    split_by_day,
)

FIXTURES = Path(__file__).parent / "fixtures" / "prepare_selection_input"


def _event(title: str, venue: str, date: str, **overrides: str) -> dict:
    base = {"title": title, "venue": venue, "date": date, "time": "", "cost": "", "url": "", "description": ""}
    base.update(overrides)
    return base


# --- End-to-end regression: the synthetic sample week ---


def test_sample_week_end_to_end_reconciles_every_raw_event() -> None:
    """No event should silently disappear -- passthrough candidates plus
    every recurring group's recurrence_count must sum back to the raw total."""
    result = build_candidates(FIXTURES / "sample-week")
    recurring = [c for c in result["candidates"] if c.get("recurrence_count")]
    passthrough = len(result["candidates"]) - len(recurring)
    consumed = sum(c["recurrence_count"] for c in recurring)

    assert result["raw_event_count"] == 5  # 3 (do215-like) + 2 (other-source); failed-source contributes 0
    # 2 exact-duplicate "Concert Y" rows collapse to 1 first, then reconciliation is against
    # the post-dedup total, not the raw total -- dedup and recurrence are independent transforms.
    assert passthrough + consumed == 4


def test_sample_week_collapses_the_do215_shaped_recurring_listing() -> None:
    result = build_candidates(FIXTURES / "sample-week")
    recurring = [c for c in result["candidates"] if c.get("recurrence_count")]
    assert len(recurring) == 1
    assert recurring[0]["title"] == "Museum Tour"
    assert recurring[0]["recurrence_count"] == 3
    assert recurring[0]["occurrences"] == ["2026-08-03", "2026-08-04", "2026-08-05"]
    assert recurring[0]["date"] == "2026-08-03"  # earliest occurrence is the representative


def test_sample_week_keeps_the_more_complete_exact_duplicate() -> None:
    result = build_candidates(FIXTURES / "sample-week")
    concert = next(c for c in result["candidates"] if c["title"] == "Concert Y")
    assert concert["cost"] == "$15"  # the complete entry, not the blank duplicate


def test_sample_week_reports_the_failed_source() -> None:
    result = build_candidates(FIXTURES / "sample-week")
    assert result["collection_failures"] == ["failed-source (timeout)"]


def test_sample_week_every_candidate_is_tagged_with_its_source() -> None:
    result = build_candidates(FIXTURES / "sample-week")
    sources = {c["source"] for c in result["candidates"]}
    assert sources == {"Do215", "Some Other Source"}


# --- load_manifest / load_candidates_from_sources ---


def test_load_manifest_reads_the_real_shape() -> None:
    manifest = load_manifest(FIXTURES / "sample-week")
    assert manifest["week"] == "2026-08-03"
    assert manifest["sources"]["failed-source"]["status"] == "failed"


def test_load_candidates_skips_failed_sources_entirely() -> None:
    manifest = load_manifest(FIXTURES / "sample-week")
    events = load_candidates_from_sources(FIXTURES / "sample-week", manifest)
    assert all(e["source"] != "failed-source" for e in events)
    assert len(events) == 5


def test_load_candidates_tags_every_event_with_the_file_level_source_name() -> None:
    """The real bug this function exists to avoid: individual event dicts in a
    source file don't carry a `source` field themselves -- only the file's
    top-level `source` key does (event_parsers/base.py's write_event has no
    source field). Naively flattening files without this tagging step loses
    which source each event came from."""
    manifest = load_manifest(FIXTURES / "sample-week")
    events = load_candidates_from_sources(FIXTURES / "sample-week", manifest)
    museum_tours = [e for e in events if e["title"] == "Museum Tour"]
    assert len(museum_tours) == 3
    assert all(e["source"] == "Do215" for e in museum_tours)


def test_load_candidates_skips_a_manifest_entry_with_no_matching_file(tmp_path: Path) -> None:
    """A manifest/file mismatch is check_yield.py's job to catch, not this
    script's -- this function just skips what it can't find rather than raising."""
    import json

    (tmp_path / "_manifest.json").write_text(
        json.dumps({"week": "2026-08-03", "sources": {"missing-source": {"status": "ok", "events": 1}}})
    )
    manifest = load_manifest(tmp_path)
    assert load_candidates_from_sources(tmp_path, manifest) == []


# --- collapse_exact_duplicates ---


def test_collapse_exact_duplicates_passes_through_a_single_entry_unchanged() -> None:
    events = [_event("Solo Show", "Venue A", "2026-08-03", source="Luma")]
    assert collapse_exact_duplicates(events) == events


def test_collapse_exact_duplicates_prefers_r5_over_do215() -> None:
    events = [
        _event("Saetia", "First Unitarian Church", "2026-08-03", source="Do215", cost="$15"),
        _event("Saetia", "First Unitarian Church", "2026-08-03", source="R5 Productions", cost="$15 -- SOLD OUT confirmed"),
    ]
    result = collapse_exact_duplicates(events)
    assert len(result) == 1
    assert result[0]["source"] == "R5 Productions"


def test_collapse_exact_duplicates_prefers_philamoca_over_philly_ask_a_punk() -> None:
    events = [
        _event("Show", "PhilaMOCA", "2026-08-03", source="Philly Ask A Punk"),
        _event("Show", "PhilaMOCA", "2026-08-03", source="PhilaMOCA"),
    ]
    result = collapse_exact_duplicates(events)
    assert result[0]["source"] == "PhilaMOCA"


def test_collapse_exact_duplicates_unlisted_sources_tiebreak_by_completeness() -> None:
    events = [
        _event("Concert Y", "Venue Z", "2026-08-03", source="Some Other Source", time="7:00 PM", cost="$15"),
        _event("Concert Y", "Venue Z", "2026-08-03", source="Another Unlisted Source"),
    ]
    result = collapse_exact_duplicates(events)
    assert len(result) == 1
    assert result[0]["cost"] == "$15"


def test_collapse_exact_duplicates_different_dates_are_not_duplicates() -> None:
    events = [
        _event("Show", "Venue", "2026-08-03", source="Luma"),
        _event("Show", "Venue", "2026-08-04", source="Luma"),
    ]
    assert len(collapse_exact_duplicates(events)) == 2


def test_collapse_exact_duplicates_preserves_a_sold_out_signal_from_a_discarded_entry() -> None:
    """v1's spec: "If any source marks an event sold out, carry that status
    regardless of which source is kept." There's no structured sold_out field
    at Collection's raw-event level (event_parsers/base.py's Event schema is
    title/venue/date/time/cost/url/description only) -- the signal lives in
    free text, so it's preserved as a note rather than silently dropped."""
    events = [
        _event("Show", "Venue", "2026-08-03", source="Do215", description="A great show."),
        _event("Show", "Venue", "2026-08-03", source="Some Other Source", description="This one is SOLD OUT."),
    ]
    result = collapse_exact_duplicates(events)
    assert len(result) == 1
    assert result[0]["source"] == "Do215"  # priority winner unchanged
    assert "sold out" in result[0]["description"].casefold()


def test_collapse_exact_duplicates_does_not_add_a_redundant_sold_out_note() -> None:
    events = [
        _event("Show", "Venue", "2026-08-03", source="R5 Productions", description="SOLD OUT already noted here."),
        _event("Show", "Venue", "2026-08-03", source="Do215", description="Also sold out."),
    ]
    result = collapse_exact_duplicates(events)
    assert result[0]["description"].count("[Note:") == 0


# --- group_recurring ---


def test_group_recurring_below_threshold_passes_through_unchanged() -> None:
    events = [_event("Show", "Venue", "2026-08-03"), _event("Show", "Venue", "2026-08-04")]
    result = group_recurring(events)
    assert len(result) == 2
    assert all("recurrence_count" not in e for e in result)


def test_group_recurring_at_threshold_collapses_to_one_annotated_representative() -> None:
    events = [
        _event("Show", "Venue", "2026-08-05"),
        _event("Show", "Venue", "2026-08-03"),
        _event("Show", "Venue", "2026-08-04"),
    ]
    result = group_recurring(events)
    assert len(result) == 1
    assert result[0]["date"] == "2026-08-03"  # earliest, not first-seen
    assert result[0]["occurrences"] == ["2026-08-03", "2026-08-04", "2026-08-05"]
    assert result[0]["recurrence_count"] == 3


def test_group_recurring_different_venues_are_not_the_same_series() -> None:
    events = [
        _event("Show", "Venue A", "2026-08-03"),
        _event("Show", "Venue B", "2026-08-04"),
        _event("Show", "Venue A", "2026-08-05"),
    ]
    result = group_recurring(events)
    assert len(result) == 3  # only 2 occurrences at Venue A -- below threshold


def test_group_recurring_repeated_dates_count_once_toward_the_threshold() -> None:
    # 4 raw entries but only 2 distinct dates -- should NOT group.
    events = [
        _event("Show", "Venue", "2026-08-03"),
        _event("Show", "Venue", "2026-08-03"),
        _event("Show", "Venue", "2026-08-04"),
        _event("Show", "Venue", "2026-08-04"),
    ]
    result = group_recurring(events)
    assert len(result) == 4
    assert all("recurrence_count" not in e for e in result)


# --- collection_failures ---


def test_collection_failures_formats_source_and_reason() -> None:
    manifest = {"sources": {"free-library": {"status": "failed", "reason": "Cloudflare bot-check"}}}
    assert collection_failures(manifest) == ["free-library (Cloudflare bot-check)"]


def test_collection_failures_ignores_ok_sources() -> None:
    manifest = {"sources": {"do215": {"status": "ok", "events": 517}}}
    assert collection_failures(manifest) == []


def test_collection_failures_sorted_alphabetically() -> None:
    manifest = {
        "sources": {
            "zzz-source": {"status": "failed", "reason": "x"},
            "aaa-source": {"status": "failed", "reason": "y"},
        }
    }
    assert collection_failures(manifest) == ["aaa-source (y)", "zzz-source (x)"]


# --- assign_ids ---


def test_assign_ids_assigns_sequential_c0000_style_ids_in_order() -> None:
    events = [_event("A", "V", "2026-08-03"), _event("B", "V", "2026-08-04"), _event("C", "V", "2026-08-05")]
    result = assign_ids(events)
    assert [c["id"] for c in result] == ["c0000", "c0001", "c0002"]


def test_assign_ids_does_not_mutate_the_input_list() -> None:
    events = [_event("A", "V", "2026-08-03")]
    assign_ids(events)
    assert "id" not in events[0]


def test_assign_ids_is_stable_across_repeated_calls_on_the_same_order() -> None:
    events = [_event("A", "V", "2026-08-03"), _event("B", "V", "2026-08-04")]
    assert assign_ids(events) == assign_ids(events)


# --- cap_descriptions ---


def test_cap_descriptions_leaves_short_descriptions_unchanged() -> None:
    events = [_event("A", "V", "2026-08-03", description="short")]
    result = cap_descriptions(events)
    assert result[0]["description"] == "short"


def test_cap_descriptions_truncates_and_appends_ellipsis() -> None:
    long_description = "x" * 700
    events = [_event("A", "V", "2026-08-03", description=long_description)]
    result = cap_descriptions(events, limit=600)
    assert len(result[0]["description"]) == 601  # 600 chars + the ellipsis char
    assert result[0]["description"].endswith("…")
    assert result[0]["description"][:600] == "x" * 600


def test_cap_descriptions_does_not_mutate_the_input() -> None:
    events = [_event("A", "V", "2026-08-03", description="x" * 700)]
    cap_descriptions(events, limit=600)
    assert len(events[0]["description"]) == 700


def test_cap_descriptions_handles_a_missing_description_field() -> None:
    events = [{"title": "A", "venue": "V", "date": "2026-08-03"}]
    result = cap_descriptions(events)
    assert result == events


# --- build_candidates: id assignment + description cap wired in ---


def test_build_candidates_assigns_a_unique_id_to_every_candidate() -> None:
    result = build_candidates(FIXTURES / "sample-week")
    ids = [c["id"] for c in result["candidates"]]
    assert len(ids) == len(set(ids)) == len(result["candidates"])
    assert all(i.startswith("c") for i in ids)


def test_build_candidates_caps_a_long_description(tmp_path: Path) -> None:
    (tmp_path / "_manifest.json").write_text(
        json.dumps({"week": "2026-08-03", "sources": {"src": {"status": "ok", "events": 1}}})
    )
    (tmp_path / "src.json").write_text(
        json.dumps({"source": "Some Source", "events": [_event("A", "V", "2026-08-03", description="y" * 900)]})
    )
    result = build_candidates(tmp_path)
    assert len(result["candidates"][0]["description"]) == 601


# --- split_by_day ---


def test_split_by_day_writes_one_file_per_date_in_the_week(tmp_path: Path) -> None:
    result = build_candidates(FIXTURES / "sample-week")
    paths = split_by_day(result, tmp_path)
    assert len(paths) == 7
    assert {p.name for p in paths} == {
        "2026-08-03.json",
        "2026-08-04.json",
        "2026-08-05.json",
        "2026-08-06.json",
        "2026-08-07.json",
        "2026-08-08.json",
        "2026-08-09.json",
    }


def test_split_by_day_places_candidates_on_their_own_date(tmp_path: Path) -> None:
    """Both sample-week candidates (Museum Tour's earliest occurrence and Concert Y)
    fall on the Monday (2026-08-03) -- the recurring candidate is grouped to its
    earliest date by group_recurring() before split_by_day ever sees it, so it
    appears only in that one day's file, not repeated across all 3 occurrences."""
    result = build_candidates(FIXTURES / "sample-week")
    split_by_day(result, tmp_path)
    monday = json.loads((tmp_path / "_candidates" / "2026-08-03.json").read_text())
    tuesday = json.loads((tmp_path / "_candidates" / "2026-08-04.json").read_text())
    assert {c["title"] for c in monday["candidates"]} == {"Museum Tour", "Concert Y"}
    assert tuesday["candidates"] == []


def test_split_by_day_empty_days_still_get_a_file_with_the_shared_metadata(tmp_path: Path) -> None:
    result = build_candidates(FIXTURES / "sample-week")
    split_by_day(result, tmp_path)
    sunday = json.loads((tmp_path / "_candidates" / "2026-08-09.json").read_text())
    assert sunday["candidates"] == []
    assert sunday["week"] == "2026-08-03"
    assert sunday["date"] == "2026-08-09"
    assert sunday["collection_failures"] == result["collection_failures"]


def test_split_by_day_raises_rather_than_silently_dropping_an_out_of_window_candidate(tmp_path: Path) -> None:
    """A candidate whose date falls outside the target week's Mon-Sun window would
    otherwise vanish with no trace once per-day files are Selection's only input --
    the same silent-drop failure class check_yield.py and merge_selections.py both
    guard against, so this must fail loudly rather than quietly omit the candidate."""
    import pytest

    result = {
        "week": "2026-08-03",
        "collection_failures": [],
        "candidates": [_event("Stray", "V", "2026-08-20", id="c0000")],
    }
    with pytest.raises(ValueError, match="Stray"):
        split_by_day(result, tmp_path)


def test_split_by_day_is_invisible_to_check_yields_non_recursive_orphan_glob(tmp_path: Path) -> None:
    """check_yield.py's _load_week_dir globs week_dir.glob("*.json") non-recursively
    -- verifying that directly, not just assuming it, since a false assumption here
    would make every real Collection run fail its own yield check."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    from check_yield import _load_week_dir

    result = build_candidates(FIXTURES / "sample-week")
    for name in ("_manifest.json", "do215-like.json", "other-source.json"):
        (tmp_path / name).write_text((FIXTURES / "sample-week" / name).read_text())
    split_by_day(result, tmp_path)

    _, _, files_on_disk = _load_week_dir(tmp_path)
    assert not any("_candidates" in f for f in files_on_disk)
