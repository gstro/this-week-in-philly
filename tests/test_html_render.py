"""Tests for scripts/html_render.py.

Two tiers: pure-helper unit tests (no disk I/O) plus a golden test that
renders the real, committed data/2026-06-22/ week and diffs against
tests/golden/actual-2026-06-22.html -- the promised "golden test" from
V2_IMPLEMENTATION_PLAN.md (:62, :119, :192, :233) that was never actually
written. See tests/golden/README.md for what deliberately differs from
v1's real historical output (tests/golden/2026-06-22.html).

The golden fixture was refreshed as part of this file landing -- a prior
version had drifted 2 lines behind html_render.py's SOURCES list (the
songkick/billy-penn removal, bdc8a84) with nothing to catch it. If this
golden test starts failing on an unrelated change, that's it working: pin
the new correct output, don't just copy the diff over blind.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import html_render as hr

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
REAL_WEEK_DIR = Path(__file__).resolve().parent.parent / "data" / "2026-06-22"

# --- display_time ---


def test_display_time_returns_various_for_empty_time() -> None:
    assert hr.display_time("", "") == "Various"


def test_display_time_appends_plus_for_multiple_showtimes() -> None:
    assert hr.display_time("7:00 PM", "Multiple showtimes daily.") == "7:00 PM+"


def test_display_time_no_plus_without_multiple_showtimes_note() -> None:
    assert hr.display_time("7:00 PM", "A regular one-off show.") == "7:00 PM"


def test_display_time_falls_back_to_various_for_a_placeholder_time() -> None:
    """Regression guard for a real bug: display_time used to strip the
    *(...)* wrapper and show the prose inside verbatim, e.g.
    "*(confirm showtimes)*" plus a "multiple showtimes" note in `note`
    rendered as the nonsensical "confirm showtimes+". Placeholder text
    belongs in note/why, not the time column -- this must always fall back
    to "Various", exactly like an empty time does."""
    assert hr.display_time("*(confirm showtimes)*", "Multiple showtimes daily.") == "Various"


def test_display_time_falls_back_to_various_for_a_long_placeholder_sentence() -> None:
    """The second half of the same regression: a full unconfirmed-detail
    sentence must not render into the narrow time column."""
    placeholder = "*(confirm details — 7:00 AM listed, possible error)*"
    assert hr.display_time(placeholder, "") == "Various"


# --- has_multiple_showtimes ---


def test_has_multiple_showtimes_is_case_insensitive() -> None:
    assert hr.has_multiple_showtimes("MULTIPLE SHOWTIMES: 1pm, 3pm")


def test_has_multiple_showtimes_false_for_none_note() -> None:
    assert hr.has_multiple_showtimes(None) is False  # type: ignore[arg-type]


# --- price_class_and_text ---


def test_price_class_and_text_sold_out_overrides_cost() -> None:
    event = {"sold_out": True, "cost": "$15"}
    assert hr.price_class_and_text(event) == ("sold-out", "SOLD OUT")


def test_price_class_and_text_free() -> None:
    event = {"sold_out": False, "cost": "free"}
    assert hr.price_class_and_text(event) == ("price-free", "free")


def test_price_class_and_text_paid() -> None:
    event = {"sold_out": False, "cost": "$15 adv / $20 DOS"}
    assert hr.price_class_and_text(event) == ("price-paid", "$15 adv / $20 DOS")


def test_price_class_and_text_placeholder_cost_still_paid_class() -> None:
    # A placeholder cost isn't a known free synonym, so it's treated as paid
    # (the stripped placeholder text is shown, not hidden).
    event = {"sold_out": False, "cost": "*(confirm details)*"}
    assert hr.price_class_and_text(event) == ("price-paid", "confirm details")


# --- build_pick_name_html ---


def test_build_pick_name_html_links_the_matched_substring() -> None:
    pick = {"title": "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin", "is_music": True, "url": "https://example.com"}
    spotify_entry = {"spotify_url": "https://open.spotify.com/artist/xyz", "matched_text": "Die Sexual"}
    html_out = hr.build_pick_name_html(pick, spotify_entry)
    assert "Gothic night: " in html_out
    assert '<a href="https://open.spotify.com/artist/xyz">Die Sexual</a>' in html_out
    assert ", Ronnie Stone &amp; DJ Baby Berlin" in html_out


def test_build_pick_name_html_falls_back_to_event_url_without_spotify_entry() -> None:
    pick = {"title": "CONTRACHARGE (chi), AGONESIAC, DISCLAIM", "is_music": True, "url": "https://philly.askapunk.net/events/483"}
    html_out = hr.build_pick_name_html(pick, None)
    assert '<a class="event-link" href="https://philly.askapunk.net/events/483">CONTRACHARGE (chi), AGONESIAC, DISCLAIM</a>' == html_out


def test_build_pick_name_html_non_music_pick_ignores_spotify_entry() -> None:
    pick = {"title": "NFC Sculpture Workshop", "is_music": False, "url": "https://iffybooks.net/"}
    html_out = hr.build_pick_name_html(pick, {"spotify_url": "https://open.spotify.com/artist/xyz", "matched_text": "NFC"})
    assert "open.spotify.com" not in html_out


def test_build_pick_name_html_escapes_title_text() -> None:
    # build_pick_name_html escapes with quote=False (only &, <, > -- apostrophes
    # are left as literal characters, matching jinja2's own autoescape behavior
    # for `'` inside text nodes).
    pick = {"title": "Johnny Brenda's <Show>", "is_music": False, "url": "https://example.com"}
    html_out = hr.build_pick_name_html(pick, None)
    assert "Johnny Brenda's &lt;Show&gt;" in html_out


# --- build_honorable_mentions_html ---


def test_build_honorable_mentions_html_joins_with_middle_dot() -> None:
    mentions = [{"title": "A", "venue": "Venue A"}, {"title": "B", "venue": "Venue B"}]
    assert hr.build_honorable_mentions_html(mentions) == "A at Venue A · B at Venue B"


def test_build_honorable_mentions_html_bolds_sold_out_suffix() -> None:
    mentions = [{"title": "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", "venue": "PhilaMOCA"}]
    result = hr.build_honorable_mentions_html(mentions)
    assert "(<strong>SOLD OUT</strong>)" in result
    assert "(SOLD OUT)" not in result.replace("(<strong>SOLD OUT</strong>)", "")


def test_build_honorable_mentions_html_returns_none_for_empty_list() -> None:
    assert hr.build_honorable_mentions_html([]) is None


# --- _parse_time_for_sort / build_categories ordering ---


def test_parse_time_for_sort_parses_standard_time() -> None:
    import datetime

    assert hr._parse_time_for_sort("7:00 PM") == datetime.time(19, 0)


def test_parse_time_for_sort_returns_none_for_unparseable_time() -> None:
    assert hr._parse_time_for_sort("Various") is None
    assert hr._parse_time_for_sort("") is None


def _event(title: str, time: str) -> dict:
    return {
        "title": title,
        "category": hr.common.CATEGORY_ORDER[0],
        "time": time,
        "url": "https://example.com",
        "venue": "Test Venue",
        "cost": "free",
    }


def test_build_categories_sorts_events_within_a_category_by_time_ascending() -> None:
    day = {"events": [_event("Late Show", "9:00 PM"), _event("Early Show", "6:00 PM")]}
    categories = hr.build_categories(day, top3_titles=set())
    names = [e["name_html"] for e in categories[0]["events"]]
    assert "Early Show" in names[0]
    assert "Late Show" in names[1]


def test_build_categories_unparseable_time_sorts_last() -> None:
    day = {"events": [_event("No Time", ""), _event("Has Time", "6:00 PM")]}
    categories = hr.build_categories(day, top3_titles=set())
    names = [e["name_html"] for e in categories[0]["events"]]
    assert "Has Time" in names[0]
    assert "No Time" in names[1]


def test_build_categories_omits_categories_with_no_events() -> None:
    day = {"events": [_event("Only Music", "7:00 PM")]}
    categories = hr.build_categories(day, top3_titles=set())
    assert len(categories) == 1
    assert categories[0]["label"] == hr.common.CATEGORY_ORDER[0]


def test_build_categories_marks_top3_events_with_star_prefix() -> None:
    day = {"events": [_event("Pick", "7:00 PM")]}
    categories = hr.build_categories(day, top3_titles={"Pick"})
    assert "⭐ " in categories[0]["events"][0]["name_html"]


# --- format_failure_note / format_date_range ---


def test_format_failure_note_splits_on_paren() -> None:
    assert hr.format_failure_note("do215 (partial — URL retrieval failed)") == "do215 unavailable this week (partial — URL retrieval failed)"


def test_format_failure_note_no_paren() -> None:
    assert hr.format_failure_note("songkick") == "songkick unavailable this week"


def test_format_date_range_same_month() -> None:
    import datetime

    assert hr.format_date_range(datetime.date(2026, 6, 22), datetime.date(2026, 6, 28)) == "June 22–28, 2026"


def test_format_date_range_spans_months() -> None:
    import datetime

    assert hr.format_date_range(datetime.date(2026, 6, 29), datetime.date(2026, 7, 5)) == "June 29 – July 5, 2026"


# --- render_report: missing _spotify.json degrades silently ---


def test_render_report_degrades_gracefully_without_spotify_file(tmp_path: Path) -> None:
    """common.load_spotify() returns {} for a missing _spotify.json (spotify_lookup.py
    hasn't run yet) -- render_report must not raise, just render plain (unlinked)
    pick names instead of Spotify-linked ones."""
    import json
    import shutil

    shutil.copy(REAL_WEEK_DIR / "_selections.json", tmp_path / "_selections.json")
    # deliberately no _spotify.json in tmp_path

    html_out = hr.render_report(tmp_path)
    assert "open.spotify.com" not in html_out
    assert "NFC Sculpture Workshop" in html_out
    # sanity: the real file does have spotify links, so this isn't a no-op check
    real_selections = json.loads((REAL_WEEK_DIR / "_selections.json").read_text())
    assert real_selections["days"][0]["top3"]


# --- Golden test ---


def test_render_report_matches_the_golden_v2_artifact() -> None:
    """The promised golden test (V2_IMPLEMENTATION_PLAN.md :62/:119/:192/:233)
    that never got written. Compares against html_render.py's OWN prior
    output (tests/golden/actual-2026-06-22.html), not v1's real report
    (tests/golden/2026-06-22.html) -- the latter differs by design; see the
    module docstring in html_render.py and tests/golden/README.md for why."""
    expected = (GOLDEN_DIR / "actual-2026-06-22.html").read_text(encoding="utf-8")
    actual = hr.render_report(REAL_WEEK_DIR)
    assert actual == expected


# --- All Week / Recurring table ---

MUSIC_CAT = "\U0001f3b5 Music & Concerts"


def _rec_event(title: str, venue: str = "A Venue", occurrences: list | None = None, **extra: object) -> dict:
    ev = {
        "title": title,
        "venue": venue,
        "time": "7:00 PM",
        "cost": "$10",
        "url": "",
        "category": MUSIC_CAT,
        "source": "Do215",
        "sold_out": False,
    }
    if occurrences:
        ev["occurrences"] = occurrences
        ev["recurrence_count"] = len(occurrences)
    ev.update(extra)
    return ev


def _rec_day(date_str: str, events: list, top3: list | None = None) -> dict:
    return {
        "date": date_str,
        "day_name": "Monday",
        "top3": top3 or [],
        "honorable_mentions": [],
        "events": events,
    }


def test_all_week_collects_recurring_events_one_row_per_series() -> None:
    days = [
        _rec_day("2026-09-01", [_rec_event("Rent", occurrences=["2026-09-01", "2026-09-02", "2026-09-03"])]),
        _rec_day("2026-09-02", [_rec_event("One-off Show")]),
    ]
    rows = hr.build_all_week(days, {})
    assert len(rows) == 1
    assert rows[0]["title"] == "Rent"
    assert rows[0]["venue"] == "A Venue"


def test_all_week_lists_this_weeks_days_and_makes_no_claim_about_the_real_run() -> None:
    """`occurrences` only ever holds dates inside the collected week, so a
    museum exhibit running through December still shows 3-7 dates. Rendering
    a first-last span would state a run length manufactured by the collection
    window as fact -- the same class of error as the invented cost strings and
    the guessed venue address this project has already had to undo."""
    days = [_rec_day("2026-09-01", [_rec_event("Standing Exhibit", occurrences=["2026-09-01", "2026-09-03", "2026-09-05"])])]
    rows = hr.build_all_week(days, {})
    assert rows[0]["days"] == "Tue, Thu, Sat"
    assert "-" not in rows[0]["days"] and "–" not in rows[0]["days"]


def test_all_week_ignores_events_below_the_recurring_threshold() -> None:
    days = [_rec_day("2026-09-01", [_rec_event("Twice Only", occurrences=["2026-09-01", "2026-09-02"])])]
    assert hr.build_all_week(days, {}) == []


def test_all_week_leaves_a_recurring_top3_pick_in_its_own_day() -> None:
    """A pick vanishing from the day it was chosen for -- with a `why` written
    about that day -- would be worse than listing it twice."""
    event = _rec_event("Special Run", occurrences=["2026-09-01", "2026-09-02", "2026-09-03"])
    days = [_rec_day("2026-09-01", [event], top3=[{"title": "Special Run"}])]
    top3_by_date = {"2026-09-01": {"Special Run"}}
    assert hr.build_all_week(days, top3_by_date) == []
    categories = hr.build_categories(days[0], {"Special Run"})
    assert any(e["name_html"] for c in categories for e in c["events"])


def test_recurring_events_are_removed_from_the_day_category_blocks() -> None:
    days = _rec_day(
        "2026-09-01",
        [
            _rec_event("Rent", occurrences=["2026-09-01", "2026-09-02", "2026-09-03"]),
            _rec_event("One-off Show"),
        ],
    )
    categories = hr.build_categories(days, set())
    titles = [e["name_html"] for c in categories for e in c["events"]]
    assert len(titles) == 1
    assert "One-off Show" in titles[0]


def test_category_block_reports_how_many_the_display_cap_dropped() -> None:
    """data/2026-06-22 has a 12-event Film bucket, so the published report for
    that week silently omitted 2 vetted events. "No silent caps" is this
    project's own rule."""
    events = [_rec_event(f"Show {i}", time="7:00 PM") for i in range(12)]
    categories = hr.build_categories(_rec_day("2026-09-01", events), set())
    assert categories[0]["true_count"] == 12
    assert len(categories[0]["events"]) == hr.CATEGORY_DISPLAY_CAP
    assert categories[0]["omitted"] == 2


def test_category_block_omitted_is_none_when_nothing_was_dropped() -> None:
    categories = hr.build_categories(_rec_day("2026-09-01", [_rec_event("Only Show")]), set())
    assert categories[0]["omitted"] is None
