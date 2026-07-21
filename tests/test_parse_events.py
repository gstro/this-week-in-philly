"""Tests for scripts/parse_events.py.

All fixtures are small, hand-crafted excerpts that mirror real markup/feed
shapes captured from live sources (2026-07-21) -- not full page dumps, which
would be hundreds of KB for some of these sources. Each fixture includes at
least one event inside the test week (2026-07-20 to 2026-07-26) and one
outside it, to exercise date filtering explicitly.

The ParseError tests are the most important ones here: they cover the exact
failure mode that made the R5 Productions bug invisible in production (a
parser that finds zero of its expected container elements should raise, not
return a plausible-looking empty list) -- see the module docstring in
parse_events.py for the incident this guards against.
"""

import datetime
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import parse_events as pe

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "parse_events"
WEEK_START = datetime.date(2026, 7, 20)
WEEK_END = datetime.date(2026, 7, 26)


def _read(name: str) -> str:
    return (FIXTURES_DIR / name).read_text()


# ---------------------------------------------------------------------------
# r5-productions
# ---------------------------------------------------------------------------


def test_r5_productions_filters_to_target_week() -> None:
    events = pe.parse_r5_productions(_read("r5-productions.html"), WEEK_START, WEEK_END)
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-22", "2026-07-24"}


def test_r5_productions_combines_tagline_and_title() -> None:
    events = pe.parse_r5_productions(_read("r5-productions.html"), WEEK_START, WEEK_END)
    pavements = next(e for e in events if "PAVEMENTS" in e["title"])
    assert pavements["title"] == "WXPN 88.5 Welcomes | PAVEMENTS (2024)"
    assert pavements["venue"] == "PhilaMOCA"
    assert pavements["cost"] == "$15.39"


def test_r5_productions_raises_on_structural_mismatch() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_r5_productions("<html><body>no events here</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# philamoca
# ---------------------------------------------------------------------------


def test_philamoca_filters_to_target_week() -> None:
    events = pe.parse_philamoca(_read("philamoca.html"), WEEK_START, WEEK_END)
    assert len(events) == 1
    assert events[0]["title"] == "Philadelphia Psychotronic Film Society"
    assert events[0]["cost"] == "$5 At Door"
    assert events[0]["date"] == "2026-07-20"


def test_philamoca_raises_on_structural_mismatch() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_philamoca("<html><body>nothing</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# phillygoth -- the thoroughness regression this exists to prevent
# ---------------------------------------------------------------------------


def test_phillygoth_extracts_every_event_in_window() -> None:
    events = pe.parse_phillygoth(_read("phillygoth.html"), WEEK_START, WEEK_END)
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
    with pytest.raises(pe.ParseError):
        pe.parse_phillygoth("<html><body>nothing</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# philly-shows.com
# ---------------------------------------------------------------------------


def test_philly_shows_filters_to_target_week() -> None:
    events = pe.parse_philly_shows(_read("philly-shows.html"), WEEK_START, WEEK_END)
    assert len(events) == 1
    assert events[0]["venue"] == "Bonks Bar -3467 Richmond Street, Phila Pa 19134"
    assert events[0]["time"] == "7:00 PM"
    assert events[0]["cost"] == "$20"


def test_philly_shows_raises_on_structural_mismatch() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_philly_shows("<html><body>nothing</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# the-rotunda
# ---------------------------------------------------------------------------


def test_the_rotunda_filters_to_target_week_and_skips_notmonth() -> None:
    events = pe.parse_the_rotunda(
        _read("the-rotunda.html"), WEEK_START, WEEK_END, context_date=datetime.date(2026, 7, 1)
    )
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-20", "2026-07-21"}
    assert all(e["venue"].startswith("The Rotunda") for e in events)


def test_the_rotunda_raises_without_context_date() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_the_rotunda(_read("the-rotunda.html"), WEEK_START, WEEK_END)


def test_the_rotunda_raises_on_structural_mismatch() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_the_rotunda(
            "<html><body>nothing</body></html>", WEEK_START, WEEK_END, context_date=datetime.date(2026, 7, 1)
        )


# ---------------------------------------------------------------------------
# philly-ask-a-punk
# ---------------------------------------------------------------------------


def test_philly_ask_a_punk_filters_and_handles_multidate() -> None:
    events = pe.parse_philly_ask_a_punk(_read("philly-ask-a-punk.json"), WEEK_START, WEEK_END)
    titles = {e["title"] for e in events}
    assert titles == {"BLEEDER (BMG), LOVERGIRL (MPLS), MYSTERY DUNGEONS, B00B", "Multi-day Festival"}


def test_philly_ask_a_punk_raises_on_invalid_json() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_philly_ask_a_punk("not json", WEEK_START, WEEK_END)


def test_philly_ask_a_punk_raises_on_non_array_json() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_philly_ask_a_punk('{"not": "an array"}', WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# luma (iCal, UTC DTSTART + EDT/EST offset)
# ---------------------------------------------------------------------------


def test_luma_filters_to_target_week() -> None:
    events = pe.parse_luma(_read("luma.ics"), WEEK_START, WEEK_END)
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-22", "2026-07-23"}


def test_luma_unescapes_ical_commas_in_location() -> None:
    events = pe.parse_luma(_read("luma.ics"), WEEK_START, WEEK_END)
    happy_hour = next(e for e in events if "Happy Hour" in e["title"])
    assert happy_hour["venue"] == "Morgan's Pier, 221 N Columbus Blvd, Philadelphia, PA 19106, USA"
    assert r"\," not in happy_hour["venue"]


def test_luma_flags_url_only_location_as_online() -> None:
    events = pe.parse_luma(_read("luma.ics"), WEEK_START, WEEK_END)
    online_event = next(e for e in events if "Online-Only" in e["title"])
    assert online_event["venue"] == "(online / see description)"
    assert online_event["url"] == "https://luma.com/event/evt-online-only"


def test_luma_empty_calendar_returns_empty_list_not_an_error() -> None:
    # Zero VEVENTs is a valid iCal state (a genuinely quiet feed), unlike
    # zero container elements in an HTML parser -- must not raise.
    events = pe.parse_luma("BEGIN:VCALENDAR\nEND:VCALENDAR\n", WEEK_START, WEEK_END)
    assert events == []


def test_luma_raises_when_response_is_not_ical_at_all() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_luma("<html><body>404 not found</body></html>", WEEK_START, WEEK_END)


# ---------------------------------------------------------------------------
# meetup (iCal, TZID=America/New_York DTSTART)
# ---------------------------------------------------------------------------


def test_meetup_filters_to_target_week() -> None:
    events = pe.parse_meetup(_read("meetup.ics"), WEEK_START, WEEK_END)
    assert len(events) == 2
    assert {e["date"] for e in events} == {"2026-07-21", "2026-07-23"}


def test_meetup_flags_missing_location_as_online() -> None:
    events = pe.parse_meetup(_read("meetup.ics"), WEEK_START, WEEK_END)
    shark = next(e for e in events if "SHARK" in e["title"])
    assert shark["venue"] == "(online)"


def test_meetup_unescapes_ical_commas_in_location() -> None:
    events = pe.parse_meetup(_read("meetup.ics"), WEEK_START, WEEK_END)
    watch_party = next(e for e in events if "Watch Party" in e["title"])
    assert watch_party["venue"] == "PhilaMOCA, 531 N 12th St, Philadelphia, PA 19123"


def test_meetup_empty_calendar_returns_empty_list_not_an_error() -> None:
    # Several real Meetup groups genuinely have zero upcoming events (see
    # the "Empty ... keep" status notes in SKILL.md) -- must not raise.
    events = pe.parse_meetup("BEGIN:VCALENDAR\nEND:VCALENDAR\n", WEEK_START, WEEK_END)
    assert events == []


def test_meetup_raises_when_response_is_not_ical_at_all() -> None:
    with pytest.raises(pe.ParseError):
        pe.parse_meetup("<html><body>404 not found</body></html>", WEEK_START, WEEK_END)


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
    import json as _json

    parsed = _json.loads(captured.out)
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
