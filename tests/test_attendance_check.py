"""Tests for scripts/attendance_check.py.

Deferred from runner.sh alongside csv_log.py -- see that file's test module
docstring. Kept covered so it doesn't rot while shelved. fetch_calendar_titles
takes `service` as a parameter, so it's tested with a fake Calendar Resource,
zero network -- the same dependency-injection pattern as test_calendar_create.py.
"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from attendance_check import fetch_calendar_titles, last_week_monday, update_attendance

# --- last_week_monday ---


def test_last_week_monday_is_exactly_seven_days_before() -> None:
    assert last_week_monday(date(2026, 6, 22)) == date(2026, 6, 15)


def test_last_week_monday_crosses_a_month_boundary() -> None:
    assert last_week_monday(date(2026, 7, 6)) == date(2026, 6, 29)


# --- fetch_calendar_titles ---


class _FakeEventsResource:
    def __init__(self, pages: list[dict]) -> None:
        self._pages = pages
        self._calls = 0
        self.list_calls: list[dict] = []

    def list(  # matches google API's camelCase kwargs (calendarId, timeMin, ...)
        self, calendarId: str, timeMin: str, timeMax: str, singleEvents: bool, pageToken: str | None = None
    ) -> "_FakeEventsResource":
        del singleEvents
        self.list_calls.append({"calendarId": calendarId, "timeMin": timeMin, "timeMax": timeMax, "pageToken": pageToken})
        self._current = self._pages[self._calls]
        self._calls += 1
        return self

    def execute(self) -> dict:
        return self._current


class _FakeService:
    def __init__(self, pages: list[dict]) -> None:
        self._events = _FakeEventsResource(pages)

    def events(self) -> _FakeEventsResource:
        return self._events


def test_fetch_calendar_titles_collects_summaries() -> None:
    service = _FakeService([{"items": [{"summary": "NFC Sculpture Workshop"}, {"summary": "Gothic Night"}]}])
    titles = fetch_calendar_titles(service, "cal-id", date(2026, 6, 15))  # type: ignore[arg-type]
    assert titles == {"NFC Sculpture Workshop", "Gothic Night"}


def test_fetch_calendar_titles_ignores_events_with_no_summary() -> None:
    service = _FakeService([{"items": [{"summary": "Has One"}, {}]}])
    titles = fetch_calendar_titles(service, "cal-id", date(2026, 6, 15))  # type: ignore[arg-type]
    assert titles == {"Has One"}


def test_fetch_calendar_titles_paginates() -> None:
    service = _FakeService(
        [
            {"items": [{"summary": "First Page Event"}], "nextPageToken": "page2"},
            {"items": [{"summary": "Second Page Event"}]},
        ]
    )
    titles = fetch_calendar_titles(service, "cal-id", date(2026, 6, 15))  # type: ignore[arg-type]
    assert titles == {"First Page Event", "Second Page Event"}


def test_fetch_calendar_titles_returns_empty_set_for_an_empty_week() -> None:
    service = _FakeService([{"items": []}])
    assert fetch_calendar_titles(service, "cal-id", date(2026, 6, 15)) == set()  # type: ignore[arg-type]


# --- update_attendance ---


def test_update_attendance_marks_present_titles_true() -> None:
    rows = [{"city": "Philadelphia", "week_of": "2026-06-15", "title": "NFC Sculpture Workshop", "attended": ""}]
    updated = update_attendance(rows, "2026-06-15", calendar_titles={"NFC Sculpture Workshop"})
    assert updated == 1
    assert rows[0]["attended"] == "true"


def test_update_attendance_marks_absent_titles_false() -> None:
    rows = [{"city": "Philadelphia", "week_of": "2026-06-15", "title": "Skipped Event", "attended": ""}]
    updated = update_attendance(rows, "2026-06-15", calendar_titles=set())
    assert updated == 1
    assert rows[0]["attended"] == "false"


def test_update_attendance_honorable_mention_rows_always_resolve_false() -> None:
    """calendar_create.py only creates events for the 21 Top 3 picks, never
    honorable mentions -- so an HM row can never be "present" and must
    always resolve to false, never left blank. Confirmed as v1's actual
    historical behavior too."""
    rows = [{"city": "Philadelphia", "week_of": "2026-06-15", "title": "An Honorable Mention", "rank": "HM", "attended": ""}]
    update_attendance(rows, "2026-06-15", calendar_titles={"Some Other Event"})
    assert rows[0]["attended"] == "false"


def test_update_attendance_skips_rows_from_other_weeks() -> None:
    rows = [{"city": "Philadelphia", "week_of": "2026-06-08", "title": "Different Week Event", "attended": ""}]
    updated = update_attendance(rows, "2026-06-15", calendar_titles=set())
    assert updated == 0
    assert rows[0]["attended"] == ""  # untouched


def test_update_attendance_skips_non_philadelphia_rows() -> None:
    rows = [{"city": "Austin", "week_of": "2026-06-15", "title": "Austin Event", "attended": ""}]
    updated = update_attendance(rows, "2026-06-15", calendar_titles={"Austin Event"})
    assert updated == 0
    assert rows[0]["attended"] == ""  # untouched -- city filter, not just title match


def test_update_attendance_returns_the_count_of_rows_touched() -> None:
    rows = [
        {"city": "Philadelphia", "week_of": "2026-06-15", "title": "A", "attended": ""},
        {"city": "Philadelphia", "week_of": "2026-06-15", "title": "B", "attended": ""},
        {"city": "Philadelphia", "week_of": "2026-06-08", "title": "C", "attended": ""},
    ]
    assert update_attendance(rows, "2026-06-15", calendar_titles={"A"}) == 2
