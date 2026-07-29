"""Tests for scripts/collect_source.py.

Offline unit tests only, via a fake requests.Session (no real HTTP) --
matching the network/offline split used elsewhere (e.g. test_fetch_raw.py).
Live network behavior is exercised manually, not in this suite: this module
owns fetch *orchestration* (pagination, per-day looping, partial-failure
handling), which is the part that's safe and fast to test with canned
responses; the parser it hands merged results to (event_parsers.do215) has
its own real-fixture-based tests in test_parse_events.py.
"""

import datetime
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from collect_source import FetchResult, _fetch_do215_day, build_output, collect_do215  # noqa: E402


class _FakeResponse:
    def __init__(self, payload: dict | None = None, status_error: Exception | None = None) -> None:
        self._payload = payload
        self._status_error = status_error

    def raise_for_status(self) -> None:
        if self._status_error:
            raise self._status_error

    def json(self) -> dict:
        assert self._payload is not None
        return self._payload


class _FakeSession:
    """Maps exact URLs to canned responses (or exceptions raised on .get itself)."""

    def __init__(self, responses: dict[str, _FakeResponse | Exception]) -> None:
        self.responses = responses
        self.requested_urls: list[str] = []

    def get(self, url: str, headers: dict, timeout: int) -> _FakeResponse:  # noqa: ANN001, ARG002
        self.requested_urls.append(url)
        result = self.responses.get(url)
        if result is None:
            raise AssertionError(f"unexpected URL requested: {url}")
        if isinstance(result, Exception):
            raise result
        return result


def _event(event_id: int) -> dict:
    return {"id": event_id, "title": f"Event {event_id}"}


# --- _fetch_do215_day: pagination ---


def test_fetch_day_stops_at_total_pages() -> None:
    day = datetime.date(2026, 8, 5)
    base = "https://do215.com/events/2026/8/5.json"
    session = _FakeSession(
        {
            base: _FakeResponse({"events": [_event(1)], "paging": {"total_pages": 2}}),
            f"{base}?page=2": _FakeResponse({"events": [_event(2)], "paging": {"total_pages": 2}}),
        }
    )
    events, failed = _fetch_do215_day(session, day)
    assert [e["id"] for e in events] == [1, 2]
    assert failed == []
    assert session.requested_urls == [base, f"{base}?page=2"]


def test_fetch_day_respects_max_pages_cap() -> None:
    day = datetime.date(2026, 8, 5)
    base = "https://do215.com/events/2026/8/5.json"
    # Claims 99 total pages, but the loop must stop at _MAX_PAGES_PER_DAY (6).
    responses = {base: _FakeResponse({"events": [_event(1)], "paging": {"total_pages": 99}})}
    for page in range(2, 8):
        responses[f"{base}?page={page}"] = _FakeResponse({"events": [_event(page)], "paging": {"total_pages": 99}})
    session = _FakeSession(responses)
    events, _failed = _fetch_do215_day(session, day)
    assert len(events) == 6


def test_fetch_day_records_failed_page_and_continues() -> None:
    day = datetime.date(2026, 8, 5)
    base = "https://do215.com/events/2026/8/5.json"
    session = _FakeSession(
        {
            base: _FakeResponse({"events": [_event(1)], "paging": {"total_pages": 2}}),
            f"{base}?page=2": ConnectionError("boom"),
        }
    )
    events, failed = _fetch_do215_day(session, day)
    assert [e["id"] for e in events] == [1]
    assert len(failed) == 1
    assert "page=2" in failed[0]


def test_fetch_day_all_pages_fail_returns_empty_with_failures_recorded() -> None:
    day = datetime.date(2026, 8, 5)
    base = "https://do215.com/events/2026/8/5.json"
    session = _FakeSession({base: ConnectionError("down")})
    events, failed = _fetch_do215_day(session, day)
    assert events == []
    assert len(failed) == 1


# --- collect_do215: day-by-day looping ---


def test_collect_do215_loops_every_day_in_window(monkeypatch: pytest.MonkeyPatch) -> None:
    seen_days: list[datetime.date] = []

    def fake_fetch_day(_session: object, day: datetime.date) -> tuple[list[dict], list[str]]:
        seen_days.append(day)
        return [_event(day.day)], []

    monkeypatch.setattr("collect_source._fetch_do215_day", fake_fetch_day)
    monkeypatch.setattr("collect_source.build_session", lambda: object())

    result = collect_do215(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert seen_days == [datetime.date(2026, 8, 3) + datetime.timedelta(days=i) for i in range(7)]
    assert len(result.raw_events) == 7
    assert result.failed_requests == []


def test_collect_do215_aggregates_failures_across_days(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_fetch_day(_session: object, day: datetime.date) -> tuple[list[dict], list[str]]:
        if day.day == 5:
            return [], ["some-url (error)"]
        return [_event(day.day)], []

    monkeypatch.setattr("collect_source._fetch_do215_day", fake_fetch_day)
    monkeypatch.setattr("collect_source.build_session", lambda: object())

    result = collect_do215(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert len(result.raw_events) == 6  # 7 days minus the one that failed
    assert result.failed_requests == ["some-url (error)"]


# --- build_output ---


def test_build_output_shape() -> None:
    output = build_output("Do215", [])
    assert output["source"] == "Do215"
    assert output["events"] == []
    assert "collected_at" in output
    # Round-trips through JSON cleanly (this is what gets written to disk).
    json.dumps(output)


def test_fetch_result_is_a_plain_dataclass() -> None:
    result = FetchResult(raw_events=[_event(1)], failed_requests=[])
    assert result.raw_events == [_event(1)]
