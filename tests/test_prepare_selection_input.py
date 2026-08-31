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
    build_recent_picks,
    cap_descriptions,
    collapse_cross_source_duplicates,
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
    """No event should silently disappear. Every raw event must be accounted
    for by exactly one of: surviving as a candidate, being consumed into a
    recurring group, or being collapsed as a duplicate (exact or
    cross-source). The two duplicate counters exist so this closes -- a
    collapsed duplicate leaves no trace on the survivor, unlike a recurring
    group's recurrence_count."""
    result = build_candidates(FIXTURES / "sample-week")
    recurring = [c for c in result["candidates"] if c.get("recurrence_count")]
    passthrough = len(result["candidates"]) - len(recurring)
    consumed = sum(c["recurrence_count"] for c in recurring)

    assert result["raw_event_count"] == 5  # 3 (do215-like) + 2 (other-source); failed-source contributes 0
    # 2 exact-duplicate "Concert Y" rows collapse to 1 first, then reconciliation is against
    # the post-dedup total, not the raw total -- dedup and recurrence are independent transforms.
    assert passthrough + consumed == 4

    # The full accounting, including both dedupe passes.
    assert (
        passthrough
        + consumed
        + result["exact_duplicates_collapsed"]
        + result["cross_source_duplicates_collapsed"]
        == result["raw_event_count"]
    )


def test_build_candidates_counts_cross_source_collapses_separately() -> None:
    """The sample week has an exact duplicate but no cross-source one, so the
    two counters must not be conflated."""
    result = build_candidates(FIXTURES / "sample-week")
    assert result["exact_duplicates_collapsed"] == 1
    assert result["cross_source_duplicates_collapsed"] == 0


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


# --- collapse_cross_source_duplicates ---
#
# The safety property under test is the SINGLE-SOURCE EXEMPTION. Grouping
# four real weeks on (date, normalized title) produced 19 groups pairing
# genuinely different rooms; every one was single-source, so restricting the
# collapse to multi-source groups excludes all of them. The Dave & Buster's
# test below is that property, not a curiosity.


def test_cross_source_collapses_the_same_event_under_different_venue_spellings() -> None:
    """The dominant real pattern: an aggregator and the venue's own feed
    naming one room differently. Exact-duplicate collapse keys on `venue`
    and so never merged these."""
    events = [
        _event("Killer Of Sheep", "Philadelphia Film Society", "2026-08-20", source="Do215"),
        _event(
            "Killer Of Sheep",
            "PFS Film Society Center, 1412 Chestnut Street, Philadelphia, PA 19102",
            "2026-08-20",
            source="Philadelphia Film Society",
        ),
    ]
    result = collapse_cross_source_duplicates(events)
    assert len(result) == 1


def test_cross_source_does_not_collapse_same_source_entries_at_different_venues() -> None:
    """Regression for the false merge this design exists to avoid: five real
    Dave & Buster's locations share the title "1 / 2 Price Games Wednesdays"
    on one date, all from Do215. They are genuinely different rooms and must
    all survive."""
    locations = [
        "Dave & Buster's - Franklin Mills, Philadelphia, PA",
        "Dave & Buster's - Plymouth Meeting, Plymouth Meeting, PA",
        "Dave & Buster's - Gloucester, Blackwood, NJ",
        "Dave & Buster's, Philadelphia, PA",
        "Dave & Buster's - Philadelphia, Philadelphia, PA",
    ]
    events = [_event("1 / 2 Price Games Wednesdays", v, "2026-08-26", source="Do215") for v in locations]
    assert len(collapse_cross_source_duplicates(events)) == 5


def test_cross_source_resolves_by_source_priority() -> None:
    """R5 Productions outranks Do215, so R5's record survives -- which is what
    carries the correct venue in the real 2026-08-10 Circle Jerks group."""
    events = [
        _event("Circle Jerks x Repo Man", "Keswick Theatre, Glenside, Pe", "2026-08-14", source="Do215"),
        _event("Circle Jerks x Repo Man", "Keswick Theatre", "2026-08-14", source="R5 Productions"),
    ]
    result = collapse_cross_source_duplicates(events)
    assert len(result) == 1
    assert result[0]["source"] == "R5 Productions"
    assert result[0]["venue"] == "Keswick Theatre"


def test_cross_source_normalizes_punctuation_and_case_in_titles() -> None:
    events = [
        _event('Christone "Kingfish" Ingram', "Upper Merion Township Building Park", "2026-08-13", source="Do215"),
        _event("christone kingfish ingram", "Concerts Under the Stars", "2026-08-13", source="WXPN"),
    ]
    assert len(collapse_cross_source_duplicates(events)) == 1


def test_cross_source_keeps_a_numbered_series_distinct() -> None:
    """Titles are never truncated for the key -- a prefix match would fuse
    these three, which really did all run in the week of 2026-08-17."""
    events = [
        _event(t, "Philadelphia Film Society", "2026-08-19", source="Do215")
        for t in ("Once Upon A Time In China", "Once Upon A Time In China Ii", "Once Upon A Time In China Iii")
    ]
    assert len(collapse_cross_source_duplicates(events)) == 3


def test_cross_source_does_not_collapse_different_dates() -> None:
    events = [
        _event("Pusher", "Philadelphia Film Society", "2026-08-14", source="Do215"),
        _event("Pusher", "PFS Film Society Center", "2026-08-15", source="Philadelphia Film Society"),
    ]
    assert len(collapse_cross_source_duplicates(events)) == 2


def test_cross_source_preserves_a_sold_out_mention_from_the_discarded_entry() -> None:
    events = [
        _event("Show", "Venue A", "2026-08-03", source="Do215", description="Tickets are SOLD OUT."),
        _event("Show", "Venue A Annex", "2026-08-03", source="R5 Productions", description="Doors at 7."),
    ]
    result = collapse_cross_source_duplicates(events)
    assert len(result) == 1
    assert result[0]["source"] == "R5 Productions"
    assert "sold out" in result[0]["description"].casefold()


def test_cross_source_carries_venue_fields_forward_from_the_discarded_entry() -> None:
    """The tranche's load-bearing case. Only do215 and philly_ask_a_punk emit
    venue_address/venue_id, and Do215 sits 4th in SOURCE_PRIORITY -- so
    whenever a higher-priority source also carries the event (the real
    PhilaMOCA-via-two-sources shape, ~95 groups over four measured weeks) the
    winner is the record WITHOUT the address. Without field-level carry-forward
    merge_selections.py sees nothing and the whole change silently no-ops."""
    events = [
        _event(
            "Show",
            "Venue A",
            "2026-08-03",
            source="Do215",
            venue_address="531 N 12th St, Philadelphia, PA 19123",
            venue_id="489700",
        ),
        _event("Show", "Venue A Annex", "2026-08-03", source="R5 Productions"),
    ]
    result = collapse_cross_source_duplicates(events)
    assert len(result) == 1
    assert result[0]["source"] == "R5 Productions"
    assert result[0]["venue_address"] == "531 N 12th St, Philadelphia, PA 19123"
    assert result[0]["venue_id"] == "489700"


def test_cross_source_does_not_overwrite_venue_fields_the_winner_already_has() -> None:
    events = [
        _event("Show", "Venue A", "2026-08-03", source="Do215", venue_address="111 Loser St"),
        _event("Show", "Venue A Annex", "2026-08-03", source="R5 Productions", venue_address="222 Winner St"),
    ]
    result = collapse_cross_source_duplicates(events)
    assert result[0]["venue_address"] == "222 Winner St"


def test_cross_source_priority_tie_falls_back_to_completeness() -> None:
    events = [
        _event("Gig", "Room One", "2026-08-03", source="Unlisted A"),
        _event("Gig", "Room Two", "2026-08-03", source="Unlisted B", time="7:00 PM", cost="$10", url="u"),
    ]
    result = collapse_cross_source_duplicates(events)
    assert len(result) == 1
    assert result[0]["source"] == "Unlisted B"


def test_cross_source_preserves_input_order_of_survivors() -> None:
    events = [
        _event("Alpha", "V1", "2026-08-03", source="Do215"),
        _event("Beta", "V2", "2026-08-03", source="Do215"),
        _event("Beta", "V2 Annex", "2026-08-03", source="WXPN"),
        _event("Gamma", "V3", "2026-08-03", source="Do215"),
    ]
    result = collapse_cross_source_duplicates(events)
    assert [e["title"] for e in result] == ["Alpha", "Beta", "Gamma"]


# --- build_recent_picks (the cross-week sidecar) ---


def _prior_week_on_disk(root, name: str, picks: list[tuple[str, str]]) -> None:  # noqa: ANN001
    d = root / name
    d.mkdir()
    days = [{"date": name, "day_name": "Monday", "top3": [{"title": t, "venue": v} for t, v in picks], "honorable_mentions": [], "events": []}]
    (d / "_selections.json").write_text(json.dumps({"week": name, "days": days}))


def test_build_recent_picks_flattens_prior_weeks_top3(tmp_path) -> None:  # noqa: ANN001
    _prior_week_on_disk(tmp_path, "2026-08-10", [("Killer Of Sheep", "Philadelphia Film Society")])
    _prior_week_on_disk(tmp_path, "2026-08-17", [("Dekalog: Parts 3 & 4", "Philadelphia Film Society")])
    (tmp_path / "2026-08-24").mkdir()
    result = build_recent_picks(tmp_path / "2026-08-24")
    assert result["week"] == "2026-08-24"
    assert {p["title"] for p in result["recent_top3"]} == {"Killer Of Sheep", "Dekalog: Parts 3 & 4"}
    assert {p["week"] for p in result["recent_top3"]} == {"2026-08-10", "2026-08-17"}


def test_build_recent_picks_is_empty_for_the_earliest_week(tmp_path) -> None:  # noqa: ANN001
    (tmp_path / "2026-06-22").mkdir()
    assert build_recent_picks(tmp_path / "2026-06-22")["recent_top3"] == []


def test_build_recent_picks_carries_only_title_venue_week(tmp_path) -> None:  # noqa: ANN001
    """The whole point is that it stays small enough for Selection to read
    cheaply -- a full _selections.json runs ~1400 lines."""
    _prior_week_on_disk(tmp_path, "2026-08-17", [("A Show", "A Venue")])
    (tmp_path / "2026-08-24").mkdir()
    entry = build_recent_picks(tmp_path / "2026-08-24")["recent_top3"][0]
    assert set(entry) == {"title", "venue", "week"}


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


def test_split_by_day_withholds_structured_venue_fields_from_selection(tmp_path: Path) -> None:
    """Selection's ONLY input is the per-day files; merge_selections.py reads
    the monolithic _candidates.json. Keeping venue_address/venue_id out of the
    per-day files is what lets the source's address reach the merge without
    reaching the model -- so philly-events-selection/SKILL.md's "candidates
    never carry an address ... written from your own memory" stays true, the
    token-optimized payloads don't grow, and the model's address stays an
    independent second opinion instead of an echo of the source's."""
    result = {
        "week": "2026-08-03",
        "collection_failures": [],
        "candidates": [
            _event(
                "Concert",
                "Venue",
                "2026-08-03",
                id="c0001",
                venue_address="304 South St, Philadelphia, PA 19147",
                venue_id="511812",
            )
        ],
    }
    split_by_day(result, tmp_path)
    monday = json.loads((tmp_path / "_candidates" / "2026-08-03.json").read_text())
    candidate = monday["candidates"][0]
    assert "venue_address" not in candidate
    assert "venue_id" not in candidate
    # everything else still rides through untouched
    assert candidate["title"] == "Concert"
    assert candidate["id"] == "c0001"
    # ...and the monolithic result the merge reads is NOT mutated by the strip
    assert result["candidates"][0]["venue_address"] == "304 South St, Philadelphia, PA 19147"


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
