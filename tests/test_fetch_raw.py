"""Tests for scripts/fetch_raw.py.

Mirrors test_fetch_page_text.py's split: offline unit tests (default `pytest`
run) vs. `@pytest.mark.network` tests against real source URLs (excluded from
CI, run manually).

fetch_raw() uses `requests`, which doesn't support file:// URLs the way
Playwright does -- so the offline tests spin up a tiny local HTTP server over
a real socket (not a mock) as the closest equivalent of the file:// fixtures
used for fetch_page_text.py, exercising the real request/response path.
"""

import functools
import http.server
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_raw as fr

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


# ---------------------------------------------------------------------------
# Unit tests -- local HTTP server, no external network, run by default
# ---------------------------------------------------------------------------


@pytest.fixture
def local_server() -> Iterator[str]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(FIXTURES_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()


def test_fetch_raw_returns_full_content(local_server: str) -> None:
    text = fr.fetch_raw(f"{local_server}/sample.json", max_chars=10_000)
    assert '"title": "Sample Event"' in text
    assert "truncated" not in text


def test_fetch_raw_truncates_over_limit(local_server: str) -> None:
    text = fr.fetch_raw(f"{local_server}/sample.json", max_chars=20)
    assert len(text) < 100
    assert "[... truncated at 20 chars ...]" in text


def test_fetch_raw_raises_for_unreachable_url() -> None:
    with pytest.raises(Exception):
        fr.fetch_raw("https://this-domain-should-not-resolve.invalid/", max_chars=1000)


def test_fetch_raw_raises_for_http_error(local_server: str) -> None:
    with pytest.raises(Exception):
        fr.fetch_raw(f"{local_server}/does-not-exist.json", max_chars=1000)


def test_main_exits_nonzero_and_reports_failure_on_stderr(capsys: pytest.CaptureFixture) -> None:
    sys.argv = ["fetch_raw.py", "https://this-domain-should-not-resolve.invalid/"]
    with pytest.raises(SystemExit) as exc_info:
        fr.main()
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "FAILED to fetch" in captured.err


# ---------------------------------------------------------------------------
# Integration tests -- real sites, network required, `pytest -m network`
# ---------------------------------------------------------------------------

_LIVE_SOURCES = [
    ("philly_ask_a_punk", "https://philly.askapunk.net/api/events", '"start_datetime"'),
    (
        "luma",
        "https://api.luma.com/ics/get?entity=discover&id=discplace-VGLZZfVwOKRD1Yd",
        "BEGIN:VCALENDAR",
    ),
]


@pytest.mark.network
@pytest.mark.parametrize("name,url,expect_substring", _LIVE_SOURCES, ids=[s[0] for s in _LIVE_SOURCES])
def test_live_source_returns_real_content(name: str, url: str, expect_substring: str) -> None:
    text = fr.fetch_raw(url, max_chars=5000)
    assert expect_substring in text, f"{name}: expected marker {expect_substring!r} not found in raw response"
