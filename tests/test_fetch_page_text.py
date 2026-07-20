"""Tests for scripts/fetch_page_text.py.

Two tiers, split deliberately:

- Unit tests (default `pytest` run, no network): exercise the real
  fetch_text() function -- not mocked -- against local file:// fixtures in
  tests/fixtures/, so truncation and basic extraction are tested against
  actual playwright behavior rather than a stand-in.

- Integration tests (`pytest -m network`, excluded from the default run):
  hit the real source URLs from .claude/skills/philadelphia-sources/SKILL.md
  and confirm each still returns real content, not an error/bot-block page.
  Not run in CI -- network-dependent, slower, and repeatedly hitting these
  sites from CI runners is closer to the kind of automated traffic some of
  them already watch for. Run manually (`pytest -m network -v`) if a source
  seems broken, or as a spot-check before trusting the Collection Routine's
  first real run.

Codifies the manual validation done while migrating philadelphia-sources/
SKILL.md off get_page_text (Phase 4) into something re-runnable, so future
site changes get caught by a test rather than discovered mid-Sunday-run.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_page_text as fpt

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def _fixture_url(name: str) -> str:
    return (FIXTURES_DIR / name).as_uri()


# ---------------------------------------------------------------------------
# Unit tests -- local fixtures, no network, run by default
# ---------------------------------------------------------------------------


def test_fetch_text_returns_visible_content() -> None:
    text = fpt.fetch_text(_fixture_url("short_page.html"), wait_ms=0, max_chars=1000)
    assert "Short Test Page" in text
    assert "small amount of text" in text


def test_fetch_text_does_not_truncate_under_limit() -> None:
    text = fpt.fetch_text(_fixture_url("short_page.html"), wait_ms=0, max_chars=1000)
    assert "truncated" not in text


def test_fetch_text_truncates_over_limit() -> None:
    text = fpt.fetch_text(_fixture_url("long_page.html"), wait_ms=0, max_chars=200)
    assert len(text) < 300  # 200 chars of content + the truncation marker
    assert text.startswith("Long Test Page")
    assert "[... truncated at 200 chars ...]" in text


def test_fetch_text_raises_for_unreachable_url() -> None:
    with pytest.raises(Exception):
        fpt.fetch_text("https://this-domain-should-not-resolve.invalid/", wait_ms=0, max_chars=1000)


def test_main_exits_nonzero_and_reports_failure_on_stderr(capsys: pytest.CaptureFixture) -> None:
    sys.argv = ["fetch_page_text.py", "https://this-domain-should-not-resolve.invalid/"]
    with pytest.raises(SystemExit) as exc_info:
        fpt.main()
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "FAILED to fetch" in captured.err


# ---------------------------------------------------------------------------
# Integration tests -- real sites, network required, `pytest -m network`
# ---------------------------------------------------------------------------

# (name, url, a substring that should appear in real content, marked xfail
# reason if the source is known-blocked rather than expected to work)
_LIVE_SOURCES = [
    ("r5_productions", "https://r5productions.com/events/", "Upcoming Events"),
    ("hive76", "https://www.hive76.org/classes/", "CLASSES"),
    ("iffy_books", "https://iffybooks.net/", "Iffy Books"),
    (
        "harriets_bookshop_eventbrite",
        "https://www.eventbrite.com/o/harrietts-bookshop-52538975313",
        "Harriett's Bookshop",
    ),
    ("free_library", "https://libwww.freelibrary.org/programs/authorevents/", "Author Events"),
    ("philamoca", "https://www.philamoca.org/", "PHILAMOCA"),
    ("cinespeak", "https://cinespeak.org/cinema/", "Cinema"),
    ("lightbox", "https://www.lightboxfilmcenter.org/", "LIGHTBOX"),
    ("phillygoth", "https://phillygoth.net/", "Phillygoth"),
    (
        "philadelphia_citizen",
        "https://thephiladelphiacitizen.org/good-citizen-calendar/",
        "Philadelphia Citizen",
    ),
    ("wxpn", "https://xpn.org/concert-and-events/", "Concert Calendar"),
    ("philly_shows", "https://www.philly-shows.com/", "PHILA"),
    ("do215_day", "https://do215.com/events/2026/7/22", "PHILADELPHIA"),
    (
        "songkick",
        "https://www.songkick.com/metro-areas/5202-us-philadelphia/july-2026",
        "Philadelphia",
    ),
]


@pytest.mark.network
@pytest.mark.parametrize("name,url,expect_substring", _LIVE_SOURCES, ids=[s[0] for s in _LIVE_SOURCES])
def test_live_source_returns_real_content(name: str, url: str, expect_substring: str) -> None:
    text = fpt.fetch_text(url, wait_ms=0, max_chars=5000)
    assert expect_substring.casefold() in text.casefold(), (
        f"{name}: expected content marker {expect_substring!r} not found -- "
        f"site markup may have changed, or a bot-block is back"
    )
    for blocked_marker in ("access denied", "performing security verification", "are you a robot"):
        assert blocked_marker not in text.casefold(), f"{name}: looks bot-blocked ({blocked_marker!r} found)"


@pytest.mark.network
def test_philadelphia_film_society_is_still_waf_blocked() -> None:
    """Regression check on a *known limitation*, not a working source.

    filmadelphia.org WAF-blocks fetch_page_text.py even with a realistic
    user-agent (confirmed Jul 2026) -- WebSearch is the documented primary
    method instead (see philadelphia-sources/SKILL.md #8). If this ever
    starts passing, the WAF configuration changed and the skill file's
    guidance should be revisited to use fetch_page_text.py directly again.
    """
    text = fpt.fetch_text("https://filmadelphia.org/showtimes/", wait_ms=0, max_chars=2000)
    assert "access denied" in text.casefold()
