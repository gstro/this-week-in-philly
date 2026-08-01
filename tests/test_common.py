"""Tests for scripts/common.py -- the shared dependency of all six
Presentation scripts (html_render, spotify_lookup, calendar_create,
csv_log, attendance_check, runner.sh). Had zero coverage before this file
despite that -- the widest blast radius of any untested module in the repo.
"""

import os
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import common

# --- is_placeholder_cost / strip_placeholder_wrapper ---


def test_is_placeholder_cost_true_for_wrapped_text() -> None:
    assert common.is_placeholder_cost("*(confirm details)*")


def test_is_placeholder_cost_true_with_surrounding_whitespace() -> None:
    assert common.is_placeholder_cost("  *(confirm details)*  ")


def test_is_placeholder_cost_false_for_plain_text() -> None:
    assert not common.is_placeholder_cost("$15 adv / $20 DOS")


def test_is_placeholder_cost_false_for_partial_wrapper() -> None:
    # Only a leading "*(" or only a trailing ")*" doesn't count -- both ends required.
    assert not common.is_placeholder_cost("*(confirm details")
    assert not common.is_placeholder_cost("confirm details)*")


def test_is_placeholder_cost_false_for_empty_string() -> None:
    assert not common.is_placeholder_cost("")


def test_strip_placeholder_wrapper_strips_the_markers() -> None:
    assert common.strip_placeholder_wrapper("*(confirm details)*") == "confirm details"


def test_strip_placeholder_wrapper_leaves_plain_text_untouched_but_stripped() -> None:
    assert common.strip_placeholder_wrapper("  $15 adv  ") == "$15 adv"


def test_strip_placeholder_wrapper_handles_empty_and_none_like_input() -> None:
    assert common.strip_placeholder_wrapper("") == ""


# --- is_free_cost ---


@pytest.mark.parametrize("cost", ["free", "Free", "FREE", "no cover", "No Cover"])
def test_is_free_cost_true_for_known_synonyms_case_insensitive(cost: str) -> None:
    assert common.is_free_cost(cost)


def test_is_free_cost_true_through_a_placeholder_wrapper() -> None:
    assert common.is_free_cost("*(free)*")


def test_is_free_cost_false_for_a_dollar_amount() -> None:
    assert not common.is_free_cost("$15 adv / $20 DOS")


def test_is_free_cost_false_for_empty_cost() -> None:
    assert not common.is_free_cost("")


# --- target_week_monday ---


def test_target_week_monday_is_strictly_after_today_when_today_is_monday() -> None:
    # Monday 2026-06-15 -- days_ahead would compute 0, which must roll to next week's
    # Monday (7 days out), not today itself. Per CLAUDE.md: "the Monday immediately
    # following the run date," never the same day.
    monday = date(2026, 6, 15)
    assert common.target_week_monday(monday) == date(2026, 6, 22)


def test_target_week_monday_from_mid_week() -> None:
    wednesday = date(2026, 6, 17)
    assert common.target_week_monday(wednesday) == date(2026, 6, 22)


def test_target_week_monday_from_sunday_rolls_to_next_day() -> None:
    sunday = date(2026, 6, 21)
    assert common.target_week_monday(sunday) == date(2026, 6, 22)


# --- week_dates ---


def test_week_dates_returns_monday_through_sunday_in_order() -> None:
    monday = date(2026, 6, 22)
    dates = common.week_dates(monday)
    assert dates == [
        date(2026, 6, 22),
        date(2026, 6, 23),
        date(2026, 6, 24),
        date(2026, 6, 25),
        date(2026, 6, 26),
        date(2026, 6, 27),
        date(2026, 6, 28),
    ]


def test_week_dates_spans_a_month_boundary() -> None:
    monday = date(2026, 6, 29)
    dates = common.week_dates(monday)
    assert dates[-1] == date(2026, 7, 5)


# --- picks_log_path ---


def test_picks_log_path_defaults_to_data_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PICKS_LOG_PATH", raising=False)
    assert common.picks_log_path() == common.DATA_DIR / "event-picks-log.csv"


def test_picks_log_path_env_override_relative_is_repo_relative(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PICKS_LOG_PATH", "scratch/test-log.csv")
    assert common.picks_log_path() == common.REPO_ROOT / "scratch" / "test-log.csv"


def test_picks_log_path_env_override_absolute_is_used_verbatim(monkeypatch: pytest.MonkeyPatch) -> None:
    abs_path = os.path.join(os.sep, "tmp", "test-log.csv")
    monkeypatch.setenv("PICKS_LOG_PATH", abs_path)
    assert common.picks_log_path() == Path(abs_path)


# --- get_calendar_credentials ---


def test_get_calendar_credentials_raises_with_all_missing_var_names(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(RuntimeError) as exc_info:
        common.get_calendar_credentials()
    message = str(exc_info.value)
    assert "GOOGLE_CLIENT_ID" in message
    assert "GOOGLE_CLIENT_SECRET" in message
    assert "GOOGLE_REFRESH_TOKEN" in message


def test_get_calendar_credentials_raises_naming_only_the_missing_ones(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-client-secret")
    monkeypatch.delenv("GOOGLE_REFRESH_TOKEN", raising=False)
    with pytest.raises(RuntimeError) as exc_info:
        common.get_calendar_credentials()
    message = str(exc_info.value)
    assert "GOOGLE_REFRESH_TOKEN" in message
    assert "GOOGLE_CLIENT_ID" not in message
    assert "GOOGLE_CLIENT_SECRET" not in message


def test_get_calendar_credentials_succeeds_with_all_vars_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "test-refresh-token")
    creds = common.get_calendar_credentials()
    assert creds.client_id == "test-client-id"
    assert creds.client_secret == "test-client-secret"
    assert creds.refresh_token == "test-refresh-token"
    assert creds.scopes == common.CALENDAR_SCOPES


# --- get_calendar_id ---


class _FakeCalendarList:
    def __init__(self, pages: list[dict]) -> None:
        self._pages = pages
        self._calls = 0

    def list(self, pageToken: str | None = None) -> "_FakeCalendarList":  # matches google API's camelCase kwarg
        del pageToken
        self._current = self._pages[self._calls]
        self._calls += 1
        return self

    def execute(self) -> dict:
        return self._current


class _FakeService:
    def __init__(self, pages: list[dict]) -> None:
        self._calendar_list = _FakeCalendarList(pages)

    def calendarList(self) -> _FakeCalendarList:  # matches google API's method naming
        return self._calendar_list


def test_get_calendar_id_finds_curated_events_by_name() -> None:
    service = _FakeService(
        [{"items": [{"summary": "Other Calendar", "id": "other-id"}, {"summary": "Curated Events", "id": "curated-id"}]}]
    )
    assert common.get_calendar_id(service) == "curated-id"  # type: ignore[arg-type]


def test_get_calendar_id_paginates_across_multiple_pages() -> None:
    service = _FakeService(
        [
            {"items": [{"summary": "Other Calendar", "id": "other-id"}], "nextPageToken": "page2"},
            {"items": [{"summary": "Curated Events", "id": "curated-id"}]},
        ]
    )
    assert common.get_calendar_id(service) == "curated-id"  # type: ignore[arg-type]


def test_get_calendar_id_raises_when_not_found() -> None:
    service = _FakeService([{"items": [{"summary": "Other Calendar", "id": "other-id"}]}])
    with pytest.raises(RuntimeError, match="Curated Events"):
        common.get_calendar_id(service)  # type: ignore[arg-type]


# --- load_selections / load_spotify ---


def test_load_selections_raises_a_clear_error_when_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Selections have not run"):
        common.load_selections(tmp_path)


def test_load_spotify_returns_empty_dict_when_missing(tmp_path: Path) -> None:
    # Distinct from load_selections: a missing _spotify.json means
    # spotify_lookup.py hasn't run yet, which html_render.py must tolerate
    # (degrade to plain links), not treat as a hard failure.
    assert common.load_spotify(tmp_path) == {}


def test_load_selections_reads_the_real_committed_fixture() -> None:
    week_dir = common.DATA_DIR / "2026-06-22"
    selections = common.load_selections(week_dir)
    assert selections["week"] == "2026-06-22"
    assert len(selections["days"]) == 7
