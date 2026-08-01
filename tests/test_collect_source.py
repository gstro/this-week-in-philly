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

from collect_source import (  # noqa: E402
    FetchResult,
    RAW_WRAPPERS,
    _fetch_do215_day,
    build_output,
    collect_do215,
    collect_lightbox,
    collect_wxpn,
)
from event_parsers import ParseError  # noqa: E402


class _FakeResponse:
    def __init__(
        self,
        payload: dict | list | None = None,
        status_error: Exception | None = None,
        headers: dict[str, str] | None = None,
        text: str | None = None,
    ) -> None:
        self._payload = payload
        self._status_error = status_error
        self.headers = headers or {}
        self.text = text or ""

    def raise_for_status(self) -> None:
        if self._status_error:
            raise self._status_error

    def json(self) -> dict | list:
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


# --- collect_wxpn: pagination via X-WP-TotalPages ---


def test_collect_wxpn_pages_until_total_pages_header(monkeypatch: pytest.MonkeyPatch) -> None:
    url1 = "https://backend.xpn.org/wp-json/wp/v2/event?per_page=100&page=1"
    url2 = "https://backend.xpn.org/wp-json/wp/v2/event?per_page=100&page=2"
    session = _FakeSession(
        {
            url1: _FakeResponse([_event(1)], headers={"X-WP-TotalPages": "2"}),
            url2: _FakeResponse([_event(2)], headers={"X-WP-TotalPages": "2"}),
        }
    )
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    result = collect_wxpn(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert [e["id"] for e in result.raw_events] == [1, 2]
    assert result.failed_requests == []


def test_collect_wxpn_respects_max_pages_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    responses = {}
    for page in range(1, 10):
        url = f"https://backend.xpn.org/wp-json/wp/v2/event?per_page=100&page={page}"
        responses[url] = _FakeResponse([_event(page)], headers={"X-WP-TotalPages": "99"})
    session = _FakeSession(responses)
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    result = collect_wxpn(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert len(result.raw_events) == 6  # _MAX_PAGES_WXPN


def test_collect_wxpn_records_failure_when_response_is_not_a_list(monkeypatch: pytest.MonkeyPatch) -> None:
    url1 = "https://backend.xpn.org/wp-json/wp/v2/event?per_page=100&page=1"
    session = _FakeSession({url1: _FakeResponse({"code": "rest_no_route"}, headers={"X-WP-TotalPages": "1"})})
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    result = collect_wxpn(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert result.raw_events == []
    assert len(result.failed_requests) == 1


# --- RAW_WRAPPERS: each source's parser gets the shape it expects ---


def test_raw_wrappers_do215_wraps_in_events_object() -> None:
    wrapped = RAW_WRAPPERS["do215"]([_event(1)])
    assert json.loads(wrapped) == {"events": [_event(1)]}


def test_raw_wrappers_wxpn_is_a_bare_array() -> None:
    wrapped = RAW_WRAPPERS["wxpn"]([_event(1)])
    assert json.loads(wrapped) == [_event(1)]


# --- collect_lightbox: two-stage index-then-details ---

_LIGHTBOX_HOME = "https://www.lightboxfilmcenter.org/"
_LIGHTBOX_INDEX_HTML = """
<li data-hook="events-card">
  <a data-hook="title" href="https://www.lightboxfilmcenter.org/events/movie-a">Movie A</a>
</li>
<li data-hook="events-card">
  <a data-hook="title" href="https://www.lightboxfilmcenter.org/events/movie-b">Movie B</a>
</li>
"""


def test_collect_lightbox_fetches_index_then_every_detail_page(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession(
        {
            _LIGHTBOX_HOME: _FakeResponse(text=_LIGHTBOX_INDEX_HTML),
            "https://www.lightboxfilmcenter.org/events/movie-a": _FakeResponse(text="<html>A detail</html>"),
            "https://www.lightboxfilmcenter.org/events/movie-b": _FakeResponse(text="<html>B detail</html>"),
        }
    )
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    result = collect_lightbox(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert len(result.raw_events) == 2
    assert result.raw_events[0] == {
        "title": "Movie A",
        "href": "https://www.lightboxfilmcenter.org/events/movie-a",
        "detail_html": "<html>A detail</html>",
    }
    assert result.failed_requests == []


def test_collect_lightbox_raises_parse_error_when_index_structurally_broken(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession({_LIGHTBOX_HOME: _FakeResponse(text="<html><body>no cards here</body></html>")})
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    with pytest.raises(ParseError):
        collect_lightbox(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))


def test_collect_lightbox_raises_parse_error_when_index_fetch_fails_entirely(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession({_LIGHTBOX_HOME: ConnectionError("down")})
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    with pytest.raises(ParseError):
        collect_lightbox(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))


def test_collect_lightbox_records_failure_for_one_broken_detail_page_but_keeps_going(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _FakeSession(
        {
            _LIGHTBOX_HOME: _FakeResponse(text=_LIGHTBOX_INDEX_HTML),
            "https://www.lightboxfilmcenter.org/events/movie-a": _FakeResponse(text="<html>A detail</html>"),
            "https://www.lightboxfilmcenter.org/events/movie-b": ConnectionError("timeout"),
        }
    )
    monkeypatch.setattr("collect_source.build_session", lambda: session)

    result = collect_lightbox(datetime.date(2026, 8, 3), datetime.date(2026, 8, 9))
    assert len(result.raw_events) == 2  # both candidates still appear...
    movie_b = next(e for e in result.raw_events if e["title"] == "Movie B")
    assert movie_b["detail_html"] is None  # ...but B's detail_html is None, not fabricated content
    assert len(result.failed_requests) == 1
