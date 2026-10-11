"""make_spotify_client: a ban-length Retry-After raises instead of sleeping."""

import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import common


@pytest.fixture
def server() -> Iterator[tuple[str, list[int]]]:
    hits: list[int] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            hits.append(1)
            if len(hits) <= int(self.headers.get("X-Fail-Count", "0")):
                self.send_response(429)
                self.send_header("Retry-After", self.headers.get("X-Retry-After", "0"))
            else:
                self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}/", hits
    finally:
        httpd.shutdown()


def test_ban_length_retry_after_raises_without_retrying(
    server: tuple[str, list[int]],
) -> None:
    url, hits = server
    sp = common.make_spotify_client()
    with pytest.raises(common.SpotifyRateLimitedError, match="85725s"):
        sp._session.get(url, headers={"X-Fail-Count": "99", "X-Retry-After": "85725"})
    assert len(hits) == 1


def test_short_retry_after_is_retried_and_counted(
    server: tuple[str, list[int]], monkeypatch: pytest.MonkeyPatch
) -> None:
    url, hits = server
    stats = common.SpotifyStats()
    monkeypatch.setattr(common, "spotify_stats", stats)
    sp = common.make_spotify_client()
    response = sp._session.get(url, headers={"X-Fail-Count": "1", "X-Retry-After": "1"})
    assert response.status_code == 200
    assert len(hits) == 2
    assert stats.rate_limit_waits == 1


def test_calls_are_counted(
    server: tuple[str, list[int]], monkeypatch: pytest.MonkeyPatch
) -> None:
    url, _ = server
    stats = common.SpotifyStats()
    monkeypatch.setattr(common, "spotify_stats", stats)
    sp = common.make_spotify_client()
    sp._session.get(url)
    sp._session.get(url)
    assert stats.calls == 2
    assert stats.summary() == "Spotify API calls: 2 (0 rate-limit waits)"
