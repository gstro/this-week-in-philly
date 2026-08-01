"""Tests for scripts/parse_events.py and scripts/event_parsers/.

All fixtures are small, hand-crafted excerpts that mirror real markup/feed
shapes captured from live sources (2026-07-21) -- not full page dumps, which
would be hundreds of KB for some of these sources. Each fixture includes at
least one event inside the test week (2026-07-20 to 2026-07-26) and one
outside it, to exercise date filtering explicitly.

The ParseError tests are the most important ones here: they cover the exact
failure mode that made the R5 Productions bug invisible in production (a
parser that finds zero of its expected container elements should raise, not
return a plausible-looking empty list) -- see event_parsers/base.py for the
incident this guards against.
"""

import datetime
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import parse_events as pe
from event_parsers import ParseError
from event_parsers import cinespeak as cinespeak_parser
from event_parsers import do215 as do215_parser
from event_parsers import lightbox as lightbox_parser
from event_parsers import luma as luma_parser
from event_parsers import meetup as meetup_parser
from event_parsers import philamoca as philamoca_parser
from event_parsers import philly_ask_a_punk as philly_ask_a_punk_parser
from event_parsers import philly_shows as philly_shows_parser
from event_parsers import phillygoth as phillygoth_parser
from event_parsers import r5_productions as r5_productions_parser
from event_parsers import the_rotunda as the_rotunda_parser
from event_parsers import wxpn as wxpn_parser

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "parse_events"
WEEK_START = datetime.date(2026, 7, 20)
WEEK_END = datetime.date(2026, 7, 26)


def _read(name: str) -> str:
    return (FIXTURES_DIR / name).read_text()


# ---------------------------------------------------------------------------
# r5-productions
# ---------------------------------------------------------------------------


def test_r5_productions_filters_to_target_week() -> None:
    events = r5_productions_parser.parse(_read("r5-productions.html"), WEEK_START, WEEK_END)
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-22", "2026-07-24"}


def test_r5_productions_combines_tagline_and_title() -> None:
    events = r5_productions_parser.parse(_read("r5-productions.html"), WEEK_START, WEEK_END)
    pavements = next(e for e in events if "PAVEMENTS" in e["title"])
    assert pavements["title"] == "WXPN 88.5 Welcomes | PAVEMENTS (2024)"
    assert pavements["venue"] == "PhilaMOCA"
    assert pavements["cost"] == "$15.39"


def test_r5_productions_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        r5_productions_parser.parse("<html><body>no events here</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# philamoca
# ---------------------------------------------------------------------------


def test_philamoca_filters_to_target_week() -> None:
    events = philamoca_parser.parse(_read("philamoca.html"), WEEK_START, WEEK_END)
    assert len(events) == 1
    assert events[0]["title"] == "Philadelphia Psychotronic Film Society"
    assert events[0]["cost"] == "$5 At Door"
    assert events[0]["date"] == "2026-07-20"


def test_philamoca_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        philamoca_parser.parse("<html><body>nothing</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# phillygoth -- the thoroughness regression this exists to prevent
# ---------------------------------------------------------------------------


def test_phillygoth_extracts_every_event_in_window() -> None:
    events = phillygoth_parser.parse(_read("phillygoth.html"), WEEK_START, WEEK_END)
    # A live run previously under-collected this exact source (2 written when
    # 7+ were in the window) by reading manually and stopping early. This
    # fixture has 4 in-window events out of 5 total -- confirms the parser
    # gets all of them, not just the first couple.
    assert len(events) == 4
    titles = {e["title"] for e in events}
    assert titles == {
        "Stabbing Westward, Priest, & Acumen Nation",
        "Death Disco",
        "Heathen Playhouse: Carnal Carnival",
        "Phoenixville PRFM",
    }


def test_phillygoth_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        phillygoth_parser.parse("<html><body>nothing</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# philly-shows.com
# ---------------------------------------------------------------------------


def test_philly_shows_filters_to_target_week() -> None:
    events = philly_shows_parser.parse(_read("philly-shows.html"), WEEK_START, WEEK_END)
    assert len(events) == 1
    assert events[0]["venue"] == "Bonks Bar -3467 Richmond Street, Phila Pa 19134"
    assert events[0]["time"] == "7:00 PM"
    assert events[0]["cost"] == "$20"


def test_philly_shows_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        philly_shows_parser.parse("<html><body>nothing</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# the-rotunda
# ---------------------------------------------------------------------------


def test_the_rotunda_filters_to_target_week_and_skips_notmonth() -> None:
    events = the_rotunda_parser.parse(
        _read("the-rotunda.html"), WEEK_START, WEEK_END, context_date=datetime.date(2026, 7, 1)
    )
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-20", "2026-07-21"}
    assert all(e["venue"].startswith("The Rotunda") for e in events)


def test_the_rotunda_raises_without_context_date() -> None:
    with pytest.raises(ParseError):
        the_rotunda_parser.parse(_read("the-rotunda.html"), WEEK_START, WEEK_END)


def test_the_rotunda_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        the_rotunda_parser.parse(
            "<html><body>nothing</body></html>", WEEK_START, WEEK_END, context_date=datetime.date(2026, 7, 1)
        )


# ---------------------------------------------------------------------------
# philly-ask-a-punk
# ---------------------------------------------------------------------------


def test_philly_ask_a_punk_filters_and_handles_multidate() -> None:
    events = philly_ask_a_punk_parser.parse(_read("philly-ask-a-punk.json"), WEEK_START, WEEK_END)
    titles = {e["title"] for e in events}
    assert titles == {"BLEEDER (BMG), LOVERGIRL (MPLS), MYSTERY DUNGEONS, B00B", "Multi-day Festival"}


def test_philly_ask_a_punk_raises_on_invalid_json() -> None:
    with pytest.raises(ParseError):
        philly_ask_a_punk_parser.parse("not json", WEEK_START, WEEK_END)


def test_philly_ask_a_punk_raises_on_non_array_json() -> None:
    with pytest.raises(ParseError):
        philly_ask_a_punk_parser.parse('{"not": "an array"}', WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# luma (iCal, UTC DTSTART + EDT/EST offset)
# ---------------------------------------------------------------------------


def test_luma_filters_to_target_week() -> None:
    events = luma_parser.parse(_read("luma.ics"), WEEK_START, WEEK_END)
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-22", "2026-07-23"}


def test_luma_unescapes_ical_commas_in_location() -> None:
    events = luma_parser.parse(_read("luma.ics"), WEEK_START, WEEK_END)
    happy_hour = next(e for e in events if "Happy Hour" in e["title"])
    assert happy_hour["venue"] == "Morgan's Pier, 221 N Columbus Blvd, Philadelphia, PA 19106, USA"
    assert r"\," not in happy_hour["venue"]


def test_luma_flags_url_only_location_as_online() -> None:
    events = luma_parser.parse(_read("luma.ics"), WEEK_START, WEEK_END)
    online_event = next(e for e in events if "Online-Only" in e["title"])
    assert online_event["venue"] == "(online / see description)"
    assert online_event["url"] == "https://luma.com/event/evt-online-only"


def test_luma_empty_calendar_returns_empty_list_not_an_error() -> None:
    # Zero VEVENTs is a valid iCal state (a genuinely quiet feed), unlike
    # zero container elements in an HTML parser -- must not raise.
    events = luma_parser.parse("BEGIN:VCALENDAR\nEND:VCALENDAR\n", WEEK_START, WEEK_END)
    assert events == []


def test_luma_raises_when_response_is_not_ical_at_all() -> None:
    with pytest.raises(ParseError):
        luma_parser.parse("<html><body>404 not found</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# meetup (iCal, TZID=America/New_York DTSTART)
# ---------------------------------------------------------------------------


def test_meetup_filters_to_target_week() -> None:
    events = meetup_parser.parse(_read("meetup.ics"), WEEK_START, WEEK_END)
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-21", "2026-07-23"}


def test_meetup_flags_missing_location_as_online() -> None:
    events = meetup_parser.parse(_read("meetup.ics"), WEEK_START, WEEK_END)
    shark = next(e for e in events if "SHARK" in e["title"])
    assert shark["venue"] == "(online)"


def test_meetup_unescapes_ical_commas_in_location() -> None:
    events = meetup_parser.parse(_read("meetup.ics"), WEEK_START, WEEK_END)
    watch_party = next(e for e in events if "Watch Party" in e["title"])
    assert watch_party["venue"] == "PhilaMOCA, 531 N 12th St, Philadelphia, PA 19123"


def test_meetup_empty_calendar_returns_empty_list_not_an_error() -> None:
    # Several real Meetup groups genuinely have zero upcoming events (see
    # the "Empty ... keep" status notes in SKILL.md) -- must not raise.
    events = meetup_parser.parse("BEGIN:VCALENDAR\nEND:VCALENDAR\n", WEEK_START, WEEK_END)
    assert events == []


def test_meetup_raises_when_response_is_not_ical_at_all() -> None:
    with pytest.raises(ParseError):
        meetup_parser.parse("<html><body>404 not found</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# do215 -- undocumented JSON API (do215.json fixture trimmed from a real
# 2026-07-29 fetch of https://do215.com/events/2026/8/5.json)
# ---------------------------------------------------------------------------

DO215_WEEK_START = datetime.date(2026, 8, 3)
DO215_WEEK_END = datetime.date(2026, 8, 9)


def test_do215_filters_to_target_week() -> None:
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    # Fixture has 3 in-window events (one -- Happy Together -- is duplicated
    # to test dedup) plus an is_ongoing:true entry and a plain stale entry,
    # both out of window.
    assert len(events) == 3
    assert {e["title"] for e in events} == {
        "Drink Responsibly",
        "Happy Together 2026 Tour",
        "KALEO - Way Down We Go Tour",
    }


def test_do215_dedupes_by_event_id() -> None:
    # The fixture includes the same event (id 17489762) twice, as real day
    # pages do when a "featured" listing bleeds across multiple day URLs.
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    titles = [e["title"] for e in events]
    assert titles.count("Happy Together 2026 Tour") == 1


def test_do215_drops_is_ongoing_events_even_when_in_window() -> None:
    # is_ongoing:true is do215's "every day"-style recurring flag. This
    # fixture's ongoing entry (Chinese Lantern Festival) is also out of
    # window by date -- confirm it's absent for the ongoing reason too, by
    # checking a window that *would* include its date.
    events = do215_parser.parse(_read("do215.json"), datetime.date(2026, 6, 1), datetime.date(2026, 6, 10))
    assert events == []


def test_do215_drops_stale_entries_outside_window_even_when_not_ongoing() -> None:
    # Board Game Night (id 17338941, dated 2026-05-13) is stale by date but
    # is_ongoing: false -- isolates pure date filtering from the is_ongoing
    # filter, using a window that genuinely excludes its date.
    events = do215_parser.parse(_read("do215.json"), datetime.date(2026, 5, 20), datetime.date(2026, 5, 26))
    assert events == []


def test_do215_uses_tz_adjusted_date_not_the_mis_offset_begin_time() -> None:
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    happy_together = next(e for e in events if "Happy Together" in e["title"])
    # tz_adjusted_begin_date is 2026-08-05T19:00:00-04:00; begin_time (wrong
    # offset, -05:00) would shift this to 8pm if used instead.
    assert happy_together["date"] == "2026-08-05"
    assert happy_together["time"] == "7:00 PM"


def test_do215_formats_venue_with_city_and_state_when_present() -> None:
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    happy_together = next(e for e in events if "Happy Together" in e["title"])
    assert happy_together["venue"] == "Lansdowne Theater, Lansdowne, PA"


def test_do215_omits_city_when_venue_has_none() -> None:
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    drink_responsibly = next(e for e in events if e["title"] == "Drink Responsibly")
    assert drink_responsibly["venue"] == "Winston On The Water"


def test_do215_marks_free_events_explicitly() -> None:
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    drink_responsibly = next(e for e in events if e["title"] == "Drink Responsibly")
    assert drink_responsibly["cost"] == "Free"


def test_do215_builds_full_url_from_permalink() -> None:
    events = do215_parser.parse(_read("do215.json"), DO215_WEEK_START, DO215_WEEK_END)
    happy_together = next(e for e in events if "Happy Together" in e["title"])
    assert happy_together["url"] == "https://do215.com/events/2026/8/5/happy-together-2026-tour-tickets"


def test_do215_raises_when_events_key_missing() -> None:
    with pytest.raises(ParseError):
        do215_parser.parse(json.dumps({"paging": {}}), DO215_WEEK_START, DO215_WEEK_END)


def test_do215_raises_on_invalid_json() -> None:
    with pytest.raises(ParseError):
        do215_parser.parse("not json at all", DO215_WEEK_START, DO215_WEEK_END)


def test_do215_empty_events_list_is_not_an_error() -> None:
    # A day genuinely having nothing scheduled is a normal, valid result --
    # distinct from the API shape itself being broken (tested above).
    events = do215_parser.parse(json.dumps({"events": []}), DO215_WEEK_START, DO215_WEEK_END)
    assert events == []


# ---------------------------------------------------------------------------
# wxpn -- WXPN's own WordPress REST API (wxpn.json fixture trimmed from a
# real 2026-07-29 fetch of backend.xpn.org/wp-json/wp/v2/event)
# ---------------------------------------------------------------------------

WXPN_WEEK_START = datetime.date(2026, 8, 3)
WXPN_WEEK_END = datetime.date(2026, 8, 9)


def test_wxpn_filters_to_target_week() -> None:
    events = wxpn_parser.parse(_read("wxpn.json"), WXPN_WEEK_START, WXPN_WEEK_END)
    # Fixture: 4 in-window, 1 out-of-window (Samantha Fish, Nov), 1 malformed
    # (no acf.date), 1 in-window with no wp `link` field.
    assert len(events) == 5
    assert "Samantha Fish" not in {e["title"] for e in events}
    assert "Malformed Entry, No Date" not in {e["title"] for e in events}


def test_wxpn_unescapes_html_entities_in_title() -> None:
    events = wxpn_parser.parse(_read("wxpn.json"), WXPN_WEEK_START, WXPN_WEEK_END)
    devin_tuel = next(e for e in events if "Devin Tuel" in e["title"])
    assert devin_tuel["title"] == "Devin Tuel & Stephen Harms / JR Everhart / Joey Sweeney"
    assert "&amp;" not in devin_tuel["title"]


def test_wxpn_time_is_blank_not_a_fake_midnight() -> None:
    # acf.date's time portion is always 00:00:00 in the real API (not a real
    # showtime) -- must not be surfaced as if it were one.
    events = wxpn_parser.parse(_read("wxpn.json"), WXPN_WEEK_START, WXPN_WEEK_END)
    pinknoise = next(e for e in events if "PINKNOISE" in e["title"])
    assert pinknoise["time"] == ""
    assert pinknoise["date"] == "2026-08-03"


def test_wxpn_skips_entries_with_no_acf_date() -> None:
    events = wxpn_parser.parse(_read("wxpn.json"), WXPN_WEEK_START, WXPN_WEEK_END)
    assert all(e["title"] != "Malformed Entry, No Date" for e in events)


def test_wxpn_url_falls_back_to_external_link_when_wp_link_missing() -> None:
    events = wxpn_parser.parse(_read("wxpn.json"), WXPN_WEEK_START, WXPN_WEEK_END)
    no_wp_link = next(e for e in events if "No wp link" in e["title"])
    assert no_wp_link["url"] == "https://tickets.example.com/no-wp-link"


def test_wxpn_description_carries_external_artist() -> None:
    events = wxpn_parser.parse(_read("wxpn.json"), WXPN_WEEK_START, WXPN_WEEK_END)
    isley = next(e for e in events if "Isley Brothers" in e["title"])
    assert isley["description"] == "The Isley Brothers / Stephanie Mills"


def test_wxpn_raises_when_response_is_not_a_list() -> None:
    with pytest.raises(ParseError):
        wxpn_parser.parse(json.dumps({"error": "not found"}), WXPN_WEEK_START, WXPN_WEEK_END)


def test_wxpn_raises_on_invalid_json() -> None:
    with pytest.raises(ParseError):
        wxpn_parser.parse("not json", WXPN_WEEK_START, WXPN_WEEK_END)


def test_wxpn_empty_list_is_not_an_error() -> None:
    events = wxpn_parser.parse("[]", WXPN_WEEK_START, WXPN_WEEK_END)
    assert events == []


# ---------------------------------------------------------------------------
# cinespeak -- server-rendered WordPress blocks (cinespeak.html fixture
# trimmed from a real 2026-07-29 fetch of cinespeak.org/cinema/)
# ---------------------------------------------------------------------------

CINESPEAK_WEEK_START = datetime.date(2026, 8, 3)
CINESPEAK_WEEK_END = datetime.date(2026, 8, 9)


def test_cinespeak_filters_to_target_week() -> None:
    events = cinespeak_parser.parse(_read("cinespeak.html"), CINESPEAK_WEEK_START, CINESPEAK_WEEK_END)
    # Fixture has 4 events total; only Crooklyn (Aug 3) is in the target week.
    assert len(events) == 1
    assert events[0]["title"] == "Crooklyn (1994)"


def test_cinespeak_parses_venue_from_maps_link_not_ticket_link() -> None:
    events = cinespeak_parser.parse(_read("cinespeak.html"), CINESPEAK_WEEK_START, CINESPEAK_WEEK_END)
    assert events[0]["venue"] == "Two Locals Brewing"
    assert events[0]["url"] == "https://cinespeak.eventive.org/schedule/6a16f9b8b94123950ecaa48d"


def test_cinespeak_handles_irregular_whitespace_in_date_string() -> None:
    # Real markup: "August 3, 2026   @ 7:00  pm" -- multiple spaces around "@".
    events = cinespeak_parser.parse(_read("cinespeak.html"), CINESPEAK_WEEK_START, CINESPEAK_WEEK_END)
    assert events[0]["date"] == "2026-08-03"
    assert events[0]["time"] == "7:00 PM"


def test_cinespeak_description_carries_the_tag_when_present() -> None:
    events = cinespeak_parser.parse(_read("cinespeak.html"), CINESPEAK_WEEK_START, CINESPEAK_WEEK_END)
    assert events[0]["description"] == "Short Narrative"


def test_cinespeak_handles_missing_tag_gracefully() -> None:
    # "Elio" (Aug 14, outside this test's window but confirms no crash) has no
    # .wp-block-post-terms element at all -- widen the window to include it.
    events = cinespeak_parser.parse(_read("cinespeak.html"), datetime.date(2026, 8, 10), datetime.date(2026, 8, 16))
    elio = next(e for e in events if "Elio" in e["title"])
    assert elio["description"] == ""


def test_cinespeak_preserves_sold_out_marker_in_title() -> None:
    events = cinespeak_parser.parse(_read("cinespeak.html"), datetime.date(2026, 8, 17), datetime.date(2026, 8, 23))
    assert any("*SOLD OUT*" in e["title"] for e in events)


def test_cinespeak_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        cinespeak_parser.parse("<html><body>nothing here</body></html>", CINESPEAK_WEEK_START, CINESPEAK_WEEK_END)


# ---------------------------------------------------------------------------
# lightbox-film-center -- two-stage source (lightbox-index.html: a real
# 2026-07-29 fetch of the homepage, trimmed to 3 of 6 real cards;
# lightbox.json: the collector-merged candidate+detail_html shape parse()
# actually consumes, built from real detail-page JSON-LD for the same 3
# events plus 2 synthetic failure-mode entries)
# ---------------------------------------------------------------------------

LIGHTBOX_WEEK_START = datetime.date(2026, 7, 27)
LIGHTBOX_WEEK_END = datetime.date(2026, 8, 2)


def test_lightbox_parse_index_extracts_title_and_href() -> None:
    candidates = lightbox_parser.parse_index(_read("lightbox-index.html"))
    assert len(candidates) == 3
    assert candidates[0] == {
        "title": "O'er the Land & Bestiary",
        "href": "https://www.lightboxfilmcenter.org/events/oer-the-land-bestiary",
    }


def test_lightbox_parse_index_raises_on_structural_mismatch() -> None:
    with pytest.raises(ParseError):
        lightbox_parser.parse_index("<html><body>nothing here</body></html>")


def test_lightbox_filters_to_target_week_using_detail_page_jsonld() -> None:
    events = lightbox_parser.parse(_read("lightbox.json"), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    # Fixture has 5 candidates: 2 in-window (real JSON-LD), 1 out-of-window
    # (Mikey and Nicky, Sep 9), 1 with a failed detail fetch (detail_html:
    # null), 1 with a detail page that has no JSON-LD Event block at all.
    assert len(events) == 2
    assert {e["title"] for e in events} == {"O'er the Land & Bestiary", "Physical Media Fair"}


def test_lightbox_uses_authoritative_year_from_detail_jsonld() -> None:
    # The homepage index never carries a year at all ("Wed, Jul 29") -- this
    # confirms the parser gets the year from the detail page's startDate,
    # not by inferring it from the year-less index text.
    events = lightbox_parser.parse(_read("lightbox.json"), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    oer = next(e for e in events if "Bestiary" in e["title"])
    assert oer["date"] == "2026-07-29"
    assert oer["time"] == "7:00 PM"


def test_lightbox_venue_combines_name_and_address() -> None:
    events = lightbox_parser.parse(_read("lightbox.json"), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    oer = next(e for e in events if "Bestiary" in e["title"])
    assert oer["venue"] == "Moore College of Art & Design, 1916 Race St, Philadelphia, PA 19103, USA"


def test_lightbox_unescapes_html_entities_from_the_templated_jsonld() -> None:
    events = lightbox_parser.parse(_read("lightbox.json"), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    oer = next(e for e in events if "Bestiary" in e["title"])
    assert oer["title"] == "O'er the Land & Bestiary"
    assert "&amp;" not in oer["title"]


def test_lightbox_skips_candidate_with_failed_detail_fetch() -> None:
    events = lightbox_parser.parse(_read("lightbox.json"), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    assert all(e["title"] != "Broken Detail Fetch" for e in events)


def test_lightbox_skips_candidate_with_no_jsonld_on_detail_page() -> None:
    # Wix returns 200 with its SPA shell even for a broken/unresolved detail
    # URL (confirmed live) -- this must be a skip, not a crash.
    events = lightbox_parser.parse(_read("lightbox.json"), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    assert all(e["title"] != "Detail Page With No JSON-LD" for e in events)


def test_lightbox_raises_on_invalid_top_level_json() -> None:
    with pytest.raises(ParseError):
        lightbox_parser.parse("not json", LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)


def test_lightbox_raises_when_not_a_list() -> None:
    with pytest.raises(ParseError):
        lightbox_parser.parse(json.dumps({"not": "a list"}), LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)


def test_lightbox_empty_candidate_list_is_not_an_error() -> None:
    events = lightbox_parser.parse("[]", LIGHTBOX_WEEK_START, LIGHTBOX_WEEK_END)
    assert events == []


# ---------------------------------------------------------------------------
# CLI / build_output
# ---------------------------------------------------------------------------


def test_build_output_shape() -> None:
    output = pe.build_output("Test Source", [])
    assert output["source"] == "Test Source"
    assert output["events"] == []
    assert "collected_at" in output


def test_main_prints_json_to_stdout_and_summary_to_stderr(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["parse_events.py", "philamoca", "--source-name", "PhilaMOCA", "--week-start", "2026-07-20", "--week-end", "2026-07-26"],
    )
    monkeypatch.setattr(sys, "stdin", type("_Stdin", (), {"read": staticmethod(lambda: _read("philamoca.html"))})())
    pe.main()
    captured = capsys.readouterr()
    assert "PhilaMOCA: 1 events parsed." in captured.err
    parsed = json.loads(captured.out)
    assert parsed["source"] == "PhilaMOCA"
    assert len(parsed["events"]) == 1


def test_main_exits_nonzero_and_reports_failure_on_stderr(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setattr(sys, "argv", ["parse_events.py", "r5-productions", "--source-name", "R5", "--week-start", "2026-07-20", "--week-end", "2026-07-26"])
    monkeypatch.setattr(sys, "stdin", type("_Stdin", (), {"read": staticmethod(lambda: "<html></html>")})())
    with pytest.raises(SystemExit) as exc_info:
        pe.main()
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "FAILED to parse" in captured.err
