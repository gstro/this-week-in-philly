"""Tests for scripts/calendar_create.py.

calendar_create.py is the one script in the pipeline that performs a real,
hard-to-undo external mutation (writes to the "Curated Events" Google
Calendar), so these tests lean on dependency injection -- a fake `service`
object standing in for the real googleapiclient Resource, following the
_FakeSession precedent in test_collect_source.py -- rather than touching
any real API. Real-write validation is --dry-run only (see runner.sh /
V2 plan Phase 4); no test here ever calls the real Calendar API.
"""

import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import calendar_create as cc
import common

EASTERN = ZoneInfo(common.CALENDAR_TIMEZONE)

# --- parse_start ---


def test_parse_start_parses_a_real_time() -> None:
    result = cc.parse_start("2026-06-22", "6:00 PM")
    assert result == datetime(2026, 6, 22, 18, 0, tzinfo=EASTERN)


def test_parse_start_returns_none_for_empty_time() -> None:
    assert cc.parse_start("2026-06-22", "") is None


def test_parse_start_returns_none_for_a_placeholder_time() -> None:
    assert cc.parse_start("2026-06-22", "*(confirm showtimes)*") is None


def test_parse_start_returns_none_for_malformed_time() -> None:
    assert cc.parse_start("2026-06-22", "not a time") is None


# --- build_event ---


def _day(date_str: str = "2026-06-22") -> dict:
    return {"date": date_str, "day_name": "Monday"}


def test_build_event_returns_none_and_warns_on_unparseable_time(capsys) -> None:  # noqa: ANN001
    pick = {"title": "Mystery Show", "time": "", "category": "🎵 Music & Concerts", "why": "why", "cost": "", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is None
    assert "Mystery Show" in capsys.readouterr().err


def test_build_event_uses_category_specific_end_time_delta() -> None:
    pick = {"title": "A Reading", "time": "6:00 PM", "category": "📚 Literary", "why": "why", "cost": "", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is not None
    start = datetime.fromisoformat(event["start"]["dateTime"])
    end = datetime.fromisoformat(event["end"]["dateTime"])
    assert end - start == cc.END_TIME_DELTA["📚 Literary"]


def test_build_event_falls_back_to_default_end_time_delta_for_uncategorized_categories() -> None:
    # Only 4 of the 9 canonical categories (Literary/Film/Music/Festivals) have a
    # documented v1 heuristic -- the other 5 (e.g. Tech & Maker) must use the
    # +2h default, not silently 0 or an unhandled KeyError.
    pick = {"title": "A Workshop", "time": "6:00 PM", "category": "💻 Tech & Maker", "why": "why", "cost": "", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is not None
    start = datetime.fromisoformat(event["start"]["dateTime"])
    end = datetime.fromisoformat(event["end"]["dateTime"])
    assert end - start == cc.DEFAULT_END_TIME_DELTA == cc.END_TIME_DELTA.get("💻 Tech & Maker", cc.DEFAULT_END_TIME_DELTA)


def test_build_event_location_omitted_without_an_address() -> None:
    pick = {"title": "A Show", "time": "6:00 PM", "category": "🎵 Music & Concerts", "why": "why", "cost": "", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is not None
    assert "location" not in event


def test_build_event_location_set_from_address_when_present() -> None:
    pick = {
        "title": "A Show", "time": "6:00 PM", "category": "🎵 Music & Concerts", "why": "why",
        "cost": "", "url": "", "address": "404 S. 20th St., Philadelphia, PA 19146",
    }
    event = cc.build_event(_day(), pick)
    assert event is not None
    assert event["location"] == "404 S. 20th St., Philadelphia, PA 19146"


def test_build_event_description_omits_cost_line_for_a_placeholder_cost() -> None:
    pick = {"title": "A Show", "time": "6:00 PM", "category": "🎵 Music & Concerts", "why": "The blurb.", "cost": "*(confirm details)*", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is not None
    assert "Cost:" not in event["description"]


def test_build_event_description_includes_confirmed_cost_line() -> None:
    pick = {"title": "A Show", "time": "6:00 PM", "category": "🎵 Music & Concerts", "why": "The blurb.", "cost": "$15 adv", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is not None
    assert "Cost: $15 adv" in event["description"]


def test_build_event_description_includes_url_when_present() -> None:
    pick = {"title": "A Show", "time": "6:00 PM", "category": "🎵 Music & Concerts", "why": "The blurb.", "cost": "", "url": "https://example.com/event"}
    event = cc.build_event(_day(), pick)
    assert event is not None
    assert "https://example.com/event" in event["description"]


def test_build_event_summary_is_the_pick_title() -> None:
    pick = {"title": "The Big Show", "time": "6:00 PM", "category": "🎵 Music & Concerts", "why": "why", "cost": "", "url": ""}
    event = cc.build_event(_day(), pick)
    assert event is not None
    assert event["summary"] == "The Big Show"


# --- clear_target_week ---


class _FakeEventsResource:
    def __init__(self, existing: list[dict]) -> None:
        self._existing = existing
        self.deleted_ids: list[str] = []
        self.list_calls: list[dict] = []

    def list(  # matches google API's camelCase kwargs (calendarId, timeMin, ...)
        self, calendarId: str, timeMin: str, timeMax: str, singleEvents: bool, pageToken: str | None = None
    ) -> "_FakeEventsResource":
        del singleEvents
        self.list_calls.append({"calendarId": calendarId, "timeMin": timeMin, "timeMax": timeMax, "pageToken": pageToken})
        return self

    def delete(self, calendarId: str, eventId: str) -> "_FakeEventsResource":
        del calendarId
        self.deleted_ids.append(eventId)
        return self

    def execute(self) -> dict:
        # Shared by both list() and delete() chains -- clear_target_week()
        # discards delete()'s return value, so returning the same shape for
        # both is harmless and keeps this fake small.
        return {"items": self._existing}


class _FakeService:
    def __init__(self, existing_events: list[dict]) -> None:
        self._events = _FakeEventsResource(existing_events)

    def events(self) -> _FakeEventsResource:
        return self._events


def test_clear_target_week_deletes_every_existing_event_in_range() -> None:
    existing = [{"id": "evt-1"}, {"id": "evt-2"}]
    service = _FakeService(existing)
    deleted = cc.clear_target_week(service, "cal-id", date(2026, 6, 22))  # type: ignore[arg-type]
    assert deleted == 2
    assert service._events.deleted_ids == ["evt-1", "evt-2"]


def test_clear_target_week_queries_the_target_week_not_the_prior_week() -> None:
    """The D2 regression this function exists to prevent: clearing the *prior*
    week instead of the target week would destroy the attendance signal
    attendance_check.py needs. Assert the query window is exactly [monday,
    monday+7days) in Eastern time -- not shifted a week either direction."""
    service = _FakeService([])
    monday = date(2026, 6, 22)
    cc.clear_target_week(service, "cal-id", monday)  # type: ignore[arg-type]
    call = service._events.list_calls[0]
    time_min = datetime.fromisoformat(call["timeMin"])
    time_max = datetime.fromisoformat(call["timeMax"])
    assert time_min == datetime(2026, 6, 22, 0, 0, tzinfo=EASTERN)
    assert time_max == datetime(2026, 6, 29, 0, 0, tzinfo=EASTERN)


def test_clear_target_week_returns_zero_when_nothing_to_clear() -> None:
    service = _FakeService([])
    assert cc.clear_target_week(service, "cal-id", date(2026, 6, 22)) == 0  # type: ignore[arg-type]
