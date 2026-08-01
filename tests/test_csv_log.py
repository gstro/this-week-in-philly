"""Tests for scripts/csv_log.py.

csv_log.py is currently NOT wired into runner.sh -- the attendance/picks-log
feedback loop is deferred by decision (see runner.sh's comment) until the
rest of the Presentation pipeline is proven end to end. These tests exist
so the script doesn't rot while shelved, not because it's in the live path.
"""

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from csv_log import (
    append_rows,
    build_rows,
    find_matching_event,
    infer_price_tier,
    load_existing_keys,
)

# --- infer_price_tier ---
# Rules per the module docstring, validated against the real archived week
# (docs/v1/Data/event-picks-log.csv, 2026-06-22, 30 rows cross-checked).


def test_infer_price_tier_sold_out_is_always_paid_regardless_of_cost() -> None:
    assert infer_price_tier("free", sold_out=True) == "paid"


def test_infer_price_tier_placeholder_cost_is_blank_never_guessed() -> None:
    assert infer_price_tier("*(confirm details)*") == ""


def test_infer_price_tier_free_synonym() -> None:
    assert infer_price_tier("free") == "free"
    assert infer_price_tier("No Cover") == "free"


def test_infer_price_tier_dollar_amount_under_15_is_low() -> None:
    assert infer_price_tier("$10") == "low"


def test_infer_price_tier_dollar_amount_15_or_over_is_paid() -> None:
    assert infer_price_tier("$15 adv / $20 DOS") == "paid"


def test_infer_price_tier_no_dollar_amount_stated_defaults_to_free() -> None:
    # "anything else (no $ amount stated)" per the docstring -- e.g. a
    # store-donation ask with no fixed number.
    assert infer_price_tier("donation to store requested") == "free"


def test_infer_price_tier_empty_cost_is_blank() -> None:
    assert infer_price_tier("") == ""


# --- find_matching_event ---


def test_find_matching_event_exact_title_match() -> None:
    mention = {"title": "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", "venue": "PhilaMOCA"}
    events = [{"title": "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", "category": "🎬 Film & Cinema", "source": "PhilaMOCA"}]
    assert find_matching_event(mention, events)["category"] == "🎬 Film & Cinema"


def test_find_matching_event_falls_back_to_fuzzy_match_above_threshold() -> None:
    """Selection sometimes writes the honorable-mention title slightly
    differently than the day's events-array entry for the same event (a
    "(SOLD OUT)" suffix added, a subtitle dropped) -- confirmed on the real
    archived week."""
    mention = {"title": "WILDWOOD, NJ (1994) — Cult Movie Monday", "venue": "PhilaMOCA"}
    events = [{"title": "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", "category": "🎬 Film & Cinema", "source": "PhilaMOCA"}]
    assert find_matching_event(mention, events)["category"] == "🎬 Film & Cinema"


def test_find_matching_event_returns_empty_dict_below_fuzzy_threshold() -> None:
    mention = {"title": "A Totally Different Event", "venue": "Somewhere"}
    events = [{"title": "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", "category": "🎬 Film & Cinema", "source": "PhilaMOCA"}]
    assert find_matching_event(mention, events) == {}


def test_find_matching_event_returns_empty_dict_for_no_events() -> None:
    assert find_matching_event({"title": "Anything", "venue": "Anywhere"}, []) == {}


# --- build_rows ---


def _selections_with_one_pick(is_music: bool = False) -> dict:
    return {
        "days": [
            {
                "day_name": "Monday",
                "date": "2026-06-22",
                "top3": [
                    {
                        "rank": 1,
                        "title": "NFC Sculpture Workshop",
                        "venue": "Iffy Books",
                        "category": "💻 Tech & Maker",
                        "source": "Iffy Books",
                        "cost": "$4.50 kit",
                        "sold_out": False,
                        "is_music": is_music,
                    }
                ],
                "honorable_mentions": [],
                "events": [],
            }
        ],
        "week": "2026-06-22",
    }


def test_build_rows_maps_category_to_the_csv_slug() -> None:
    rows = build_rows(_selections_with_one_pick(), spotify={})
    assert rows[0]["category"] == "tech"


def test_build_rows_top3_rank_is_stringified() -> None:
    rows = build_rows(_selections_with_one_pick(), spotify={})
    assert rows[0]["rank"] == "1"


def test_build_rows_non_music_pick_has_no_spotify_link_even_if_present() -> None:
    spotify = {"NFC Sculpture Workshop": {"spotify_url": "https://open.spotify.com/artist/xyz", "matched_text": "x"}}
    rows = build_rows(_selections_with_one_pick(is_music=False), spotify=spotify)
    assert rows[0]["spotify_link"] == ""


def test_build_rows_music_pick_includes_its_spotify_link() -> None:
    spotify = {"NFC Sculpture Workshop": {"spotify_url": "https://open.spotify.com/artist/xyz", "matched_text": "x"}}
    rows = build_rows(_selections_with_one_pick(is_music=True), spotify=spotify)
    assert rows[0]["spotify_link"] == "https://open.spotify.com/artist/xyz"


def test_build_rows_tags_and_attended_are_always_blank() -> None:
    # Per the module docstring: no tag/theme data exists in _selections.json
    # to derive `tags` from deterministically, and `attended` is filled in
    # retrospectively by attendance_check.py, never guessed here.
    rows = build_rows(_selections_with_one_pick(), spotify={})
    assert rows[0]["tags"] == ""
    assert rows[0]["attended"] == ""


def test_build_rows_includes_honorable_mentions_with_hm_rank() -> None:
    selections = {
        "week": "2026-06-22",
        "days": [
            {
                "day_name": "Monday",
                "date": "2026-06-22",
                "top3": [],
                "honorable_mentions": [{"title": "ROAR (1981) — After Hours Curated", "venue": "Philadelphia Film Society"}],
                "events": [
                    {
                        "title": "ROAR (1981) — After Hours Curated",
                        "category": "🎬 Film & Cinema",
                        "source": "Philadelphia Film Society",
                        "cost": "free",
                        "sold_out": False,
                    }
                ],
            }
        ],
    }
    rows = build_rows(selections, spotify={})
    assert len(rows) == 1
    assert rows[0]["rank"] == "HM"
    assert rows[0]["category"] == "film"


# --- load_existing_keys / append_rows ---


def test_load_existing_keys_returns_empty_set_for_missing_file(tmp_path: Path) -> None:
    assert load_existing_keys(tmp_path / "does-not-exist.csv") == set()


def test_append_rows_writes_a_header_on_first_write(tmp_path: Path) -> None:
    path = tmp_path / "log.csv"
    rows = build_rows(_selections_with_one_pick(), spotify={})
    written = append_rows(path, rows)
    assert written == 1
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames is not None
        assert "city" in reader.fieldnames
        assert len(list(reader)) == 1


def test_append_rows_does_not_duplicate_the_header_on_a_second_write(tmp_path: Path) -> None:
    path = tmp_path / "log.csv"
    rows = build_rows(_selections_with_one_pick(), spotify={})
    append_rows(path, rows)
    append_rows(path, rows)
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        assert len(list(reader)) == 2  # csv_log.py's own idempotency (existing-keys skip) is main()'s job, not append_rows'


def test_load_existing_keys_reflects_a_previously_appended_row(tmp_path: Path) -> None:
    path = tmp_path / "log.csv"
    rows = build_rows(_selections_with_one_pick(), spotify={})
    append_rows(path, rows)
    assert ("2026-06-22", "NFC Sculpture Workshop") in load_existing_keys(path)
