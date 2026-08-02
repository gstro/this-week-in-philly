"""Tests for scripts/merge_selections.py.

All fixtures are small inline dicts, not files on disk -- the merge logic is
pure functions over already-parsed JSON, following tests/test_prepare_selection_input.py's
precedent of not needing disk I/O to exercise transform logic. The CLI wiring
(main() reading/writing the two files) is covered separately, against tmp_path.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from merge_selections import (
    MergeError,
    build_events,
    build_honorable_mentions,
    build_top3,
    merge,
)

MUSIC = "\U0001f3b5 Music & Concerts"
FILM = "\U0001f3ac Film & Cinema"
COMMUNITY = "\U0001f91d Community & Politics"


def _candidate(id_: str, title: str, venue: str, date: str, **overrides: object) -> dict:
    base = {
        "id": id_,
        "title": title,
        "venue": venue,
        "date": date,
        "time": "7:00 PM",
        "cost": "$10",
        "url": "https://example.com/" + id_,
        "source": "Some Source",
        "description": "",
    }
    base.update(overrides)
    return base


def _candidates_doc(candidates: list[dict], collection_failures: list | None = None) -> dict:
    return {
        "week": "2026-08-03",
        "collection_failures": collection_failures or [],
        "raw_event_count": len(candidates),
        "candidates": candidates,
    }


def _annotation(id_: str, category: str = MUSIC, sold_out: bool = False, note: str | None = None) -> dict:
    a: dict = {"id": id_, "category": category, "sold_out": sold_out}
    if note:
        a["note"] = note
    return a


def _top3_pick(id_: str, rank: int = 1, category: str = MUSIC, is_music: bool = True, sold_out: bool = False, why: str = "Great show.", address: str | None = None) -> dict:
    p: dict = {"id": id_, "rank": rank, "category": category, "is_music": is_music, "sold_out": sold_out, "why": why}
    if address:
        p["address"] = address
    return p


def _day(date: str, day_name: str = "Monday", top3: list | None = None, honorable_mentions: list | None = None, annotations: list | None = None) -> dict:
    return {
        "date": date,
        "day_name": day_name,
        "top3": top3 or [],
        "honorable_mentions": honorable_mentions or [],
        "annotations": annotations or [],
    }


def _annotations_doc(days: list[dict], week: str = "2026-08-03", collection_failures: list | None = None) -> dict:
    return {"week": week, "collection_failures": collection_failures or [], "days": days}


# --- merge: end-to-end happy path ---


def test_merge_reconciles_a_simple_day_with_one_top3_and_one_listed_event() -> None:
    candidates = _candidates_doc(
        [
            _candidate("c0000", "Saetia", "First Unitarian Church", "2026-08-03", cost="$15", source="R5 Productions"),
            _candidate("c0001", "Bright Bulb Screenings", "The Rotunda", "2026-08-03", cost="Free", source="The Rotunda"),
        ]
    )
    annotations = _annotations_doc(
        [
            _day(
                "2026-08-03",
                top3=[_top3_pick("c0000", rank=1, category=MUSIC, why="Rare reunion show.", address="2125 Chestnut St")],
                annotations=[_annotation("c0000", category=MUSIC), _annotation("c0001", category=FILM, note="Monthly repertory night.")],
            )
        ]
    )
    result = merge(candidates, annotations)
    assert result["week"] == "2026-08-03"
    assert result["total_events_after_dedup"] == 2
    day = result["days"][0]
    assert len(day["top3"]) == 1
    assert day["top3"][0] == {
        "rank": 1,
        "title": "Saetia",
        "venue": "First Unitarian Church",
        "address": "2125 Chestnut St",
        "time": "7:00 PM",
        "cost": "$15",
        "url": "https://example.com/c0000",
        "category": MUSIC,
        "source": "R5 Productions",
        "is_music": True,
        "sold_out": False,
        "why": "Rare reunion show.",
    }
    assert len(day["events"]) == 2  # both the top3 pick and the plain listing


def test_merge_top3_pick_appears_in_events_with_its_annotated_note() -> None:
    candidates = _candidates_doc([_candidate("c0000", "Saetia", "Venue", "2026-08-03")])
    annotations = _annotations_doc(
        [_day("2026-08-03", top3=[_top3_pick("c0000")], annotations=[_annotation("c0000", note="Also a benefit show.")])]
    )
    result = merge(candidates, annotations)
    event = result["days"][0]["events"][0]
    assert event["title"] == "Saetia"
    assert event["note"] == "Also a benefit show."
    assert "is_music" not in event  # zero consumers read is_music off events[]


# --- id resolution failures ---


def test_top3_unknown_id_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", top3=[_top3_pick("c9999")], annotations=[_annotation("c9999")])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "c9999" in str(exc)


def test_top3_id_whose_candidate_date_does_not_match_the_day_raises() -> None:
    """A day-agent misfiling an event under the wrong date -- the id resolves,
    but to a candidate that belongs to a different day."""
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-04")])
    annotations = _annotations_doc([_day("2026-08-03", top3=[_top3_pick("c0000")], annotations=[_annotation("c0000")])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "c0000" in str(exc) and "2026-08-04" in str(exc) and "2026-08-03" in str(exc)


def test_top3_id_absent_from_that_days_annotations_raises() -> None:
    """A top3 pick must also appear in the day's own annotations -- otherwise it
    would have no entry in events[]."""
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", top3=[_top3_pick("c0000")], annotations=[])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "c0000" in str(exc)


def test_honorable_mention_id_absent_from_annotations_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", honorable_mentions=[{"id": "c0000"}], annotations=[])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "c0000" in str(exc)


def test_honorable_mention_unknown_id_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", honorable_mentions=[{"id": "c9999"}], annotations=[_annotation("c9999")])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "c9999" in str(exc)


def test_annotation_missing_category_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    day = _day("2026-08-03", annotations=[{"id": "c0000", "sold_out": False}])
    annotations = _annotations_doc([day])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "category" in str(exc)


def test_annotation_missing_sold_out_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    day = _day("2026-08-03", annotations=[{"id": "c0000", "category": MUSIC}])
    annotations = _annotations_doc([day])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "sold_out" in str(exc)


def test_annotation_non_canonical_category_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", annotations=[_annotation("c0000", category="Music")])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "Music" in str(exc)


def test_annotation_date_mismatch_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-04")])
    annotations = _annotations_doc([_day("2026-08-03", annotations=[_annotation("c0000")])])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "c0000" in str(exc)


def test_top3_missing_required_field_raises() -> None:
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    day = _day("2026-08-03", top3=[{"id": "c0000", "rank": 1}], annotations=[_annotation("c0000")])
    annotations = _annotations_doc([day])
    try:
        merge(candidates, annotations)
        raise AssertionError("expected MergeError")
    except MergeError as exc:
        assert "why" in str(exc) or "category" in str(exc)


# --- verbatim field copying ---


def test_events_copy_title_venue_time_cost_url_source_verbatim() -> None:
    candidate = _candidate("c0000", "The Show", "The Venue", "2026-08-03", time="9:30 PM", cost="$20", source="Luma")
    candidates = _candidates_doc([candidate])
    annotations = _annotations_doc([_day("2026-08-03", annotations=[_annotation("c0000")])])
    event = build_events(annotations["days"][0], candidates, {"c0000": candidate})[0]
    assert event["title"] == "The Show"
    assert event["venue"] == "The Venue"
    assert event["time"] == "9:30 PM"
    assert event["cost"] == "$20"
    assert event["url"] == "https://example.com/c0000"
    assert event["source"] == "Luma"


def test_top3_titles_resolve_from_the_candidate_not_the_annotation() -> None:
    """Closes the real 62-of-562 drift bug: Selection never gets to retype a
    title -- it can only reference a candidate id, so top3's title always
    matches events[]'s title exactly."""
    candidate = _candidate("c0000", "Exact Original Title", "V", "2026-08-03")
    candidates = _candidates_doc([candidate])
    annotations = _annotations_doc([_day("2026-08-03", top3=[_top3_pick("c0000")], annotations=[_annotation("c0000")])])
    result = merge(candidates, annotations)
    day = result["days"][0]
    assert day["top3"][0]["title"] == "Exact Original Title"
    assert any(e["title"] == "Exact Original Title" for e in day["events"])


# --- category ordering + chronological tie-break ---


def test_events_are_grouped_by_category_order_then_chronological() -> None:
    candidates = _candidates_doc(
        [
            _candidate("c0000", "Film Late", "V", "2026-08-03", time="9:00 PM"),
            _candidate("c0001", "Music Early", "V", "2026-08-03", time="6:00 PM"),
            _candidate("c0002", "Film Early", "V", "2026-08-03", time="5:00 PM"),
        ]
    )
    annotations = _annotations_doc(
        [
            _day(
                "2026-08-03",
                annotations=[
                    _annotation("c0000", category=FILM),
                    _annotation("c0001", category=MUSIC),
                    _annotation("c0002", category=FILM),
                ],
            )
        ]
    )
    result = merge(candidates, annotations)
    titles = [e["title"] for e in result["days"][0]["events"]]
    # Music & Concerts sorts before Film & Cinema per common.CATEGORY_ORDER;
    # within Film & Cinema, 5:00 PM sorts before 9:00 PM.
    assert titles == ["Music Early", "Film Early", "Film Late"]


def test_events_with_the_same_time_break_ties_by_original_candidate_order() -> None:
    candidates = _candidates_doc(
        [
            _candidate("c0000", "Second In Candidates", "V", "2026-08-03", time="7:00 PM"),
            _candidate("c0001", "First In Candidates", "V", "2026-08-03", time="7:00 PM"),
        ]
    )
    # Annotations list them in the opposite order -- the tie-break must
    # follow _candidates.json's order, not the annotations list's order.
    annotations = _annotations_doc(
        [_day("2026-08-03", annotations=[_annotation("c0001"), _annotation("c0000")])]
    )
    result = merge(candidates, annotations)
    titles = [e["title"] for e in result["days"][0]["events"]]
    assert titles == ["Second In Candidates", "First In Candidates"]


def test_unparseable_or_missing_time_sorts_last_within_its_category() -> None:
    candidates = _candidates_doc(
        [
            _candidate("c0000", "No Time", "V", "2026-08-03", time=""),
            _candidate("c0001", "Has Time", "V", "2026-08-03", time="7:00 PM"),
        ]
    )
    annotations = _annotations_doc([_day("2026-08-03", annotations=[_annotation("c0000"), _annotation("c0001")])])
    result = merge(candidates, annotations)
    titles = [e["title"] for e in result["days"][0]["events"]]
    assert titles == ["Has Time", "No Time"]


# --- round trip: every annotated candidate appears exactly once ---


def test_every_annotated_candidate_appears_exactly_once_in_events() -> None:
    candidates = _candidates_doc([_candidate(f"c{i:04d}", f"Event {i}", "V", "2026-08-03") for i in range(10)])
    day = _day("2026-08-03", annotations=[_annotation(f"c{i:04d}", category=MUSIC if i % 2 == 0 else FILM) for i in range(10)])
    annotations = _annotations_doc([day])
    result = merge(candidates, annotations)
    titles = [e["title"] for e in result["days"][0]["events"]]
    assert sorted(titles) == sorted(f"Event {i}" for i in range(10))
    assert len(titles) == len(set(titles))


def test_a_candidate_with_no_annotation_is_simply_not_listed() -> None:
    """Not every candidate needs to be annotated -- the per-category cap
    (Phase 3) means some candidates are legitimately dropped from the report,
    not every one of them a bug."""
    candidates = _candidates_doc([_candidate("c0000", "Listed", "V", "2026-08-03"), _candidate("c0001", "Unlisted", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", annotations=[_annotation("c0000")])])
    result = merge(candidates, annotations)
    titles = [e["title"] for e in result["days"][0]["events"]]
    assert titles == ["Listed"]


# --- honorable mentions ---


def test_honorable_mentions_carry_only_title_and_venue() -> None:
    candidates = _candidates_doc([_candidate("c0000", "HM Event", "HM Venue", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", honorable_mentions=[{"id": "c0000"}], annotations=[_annotation("c0000")])])
    result = merge(candidates, annotations)
    assert result["days"][0]["honorable_mentions"] == [{"title": "HM Event", "venue": "HM Venue"}]


# --- collection_failures passthrough ---


def test_collection_failures_come_from_the_annotations_doc() -> None:
    candidates = _candidates_doc([], collection_failures=["from-candidates (x)"])
    annotations = _annotations_doc([], collection_failures=["from-annotations (y)"])
    result = merge(candidates, annotations)
    assert result["collection_failures"] == ["from-annotations (y)"]


def test_collection_failures_fall_back_to_the_candidates_doc_if_annotations_omits_it() -> None:
    candidates = _candidates_doc([], collection_failures=["from-candidates (x)"])
    annotations = {"week": "2026-08-03", "days": []}
    result = merge(candidates, annotations)
    assert result["collection_failures"] == ["from-candidates (x)"]


# --- build_top3 / build_honorable_mentions in isolation ---


def test_build_top3_omits_address_when_not_provided() -> None:
    candidate = _candidate("c0000", "A", "V", "2026-08-03")
    day = _day("2026-08-03", top3=[_top3_pick("c0000")], annotations=[_annotation("c0000")])
    picks = build_top3(day, {"c0000": candidate}, {"c0000": _annotation("c0000")})
    assert "address" not in picks[0]


def test_build_honorable_mentions_empty_list_when_none_present() -> None:
    day = _day("2026-08-03")
    assert build_honorable_mentions(day, {}, {}) == []


# --- CLI wiring ---


def test_main_reads_both_input_files_and_writes_selections_json(tmp_path: Path, monkeypatch: object) -> None:
    import subprocess

    week_dir = tmp_path / "2026-08-03"
    week_dir.mkdir()
    candidates = _candidates_doc([_candidate("c0000", "A", "V", "2026-08-03")])
    annotations = _annotations_doc([_day("2026-08-03", top3=[_top3_pick("c0000")], annotations=[_annotation("c0000")])])
    (week_dir / "_candidates.json").write_text(json.dumps(candidates))
    (week_dir / "_selection_annotations.json").write_text(json.dumps(annotations))

    script = Path(__file__).resolve().parent.parent / "scripts" / "merge_selections.py"
    subprocess.run([sys.executable, str(script), str(week_dir)], check=True, capture_output=True, text=True)

    written = json.loads((week_dir / "_selections.json").read_text())
    assert written["days"][0]["top3"][0]["title"] == "A"


def test_main_exits_nonzero_and_prints_a_clean_message_on_merge_error(tmp_path: Path) -> None:
    import subprocess

    week_dir = tmp_path / "2026-08-03"
    week_dir.mkdir()
    candidates = _candidates_doc([])
    annotations = _annotations_doc([_day("2026-08-03", top3=[_top3_pick("c9999")], annotations=[_annotation("c9999")])])
    (week_dir / "_candidates.json").write_text(json.dumps(candidates))
    (week_dir / "_selection_annotations.json").write_text(json.dumps(annotations))

    script = Path(__file__).resolve().parent.parent / "scripts" / "merge_selections.py"
    result = subprocess.run([sys.executable, str(script), str(week_dir)], check=False, capture_output=True, text=True)
    assert result.returncode == 1
    assert "c9999" in result.stderr
    assert not (week_dir / "_selections.json").exists()
