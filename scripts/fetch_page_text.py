#!/usr/bin/env python3
"""Renders a URL in a real (headless) browser and prints its visible text.

Replacement for Claude in Chrome's `get_page_text`, which is not available
as a Routine tool (confirmed in the Phase 0 spike). Used by the Collection
Routine via Bash for sources that need JS rendering or just don't have a
clean JSON/iCal API -- see philadelphia-sources/SKILL.md for which sources
use this and any per-source notes.

Not part of the runner.sh/presentation.yml script suite -- this is invoked
directly by the Collection Routine's own session, which is why playwright
lives in its own requirements file (scripts/requirements-collection.txt)
rather than the main scripts/requirements.txt: presentation.yml (GitHub
Actions) never needs a browser, so there's no reason to burden it with the
dependency.
"""

import argparse
import os
import sys
from collections.abc import Callable
from pathlib import Path

import requests
from playwright.sync_api import Route
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

# Some cloud Routine environments pre-bake a Chromium install at this fixed
# path specifically so sessions don't need `playwright install` (which needs
# apt-get/root for --with-deps and isn't available in these sandboxes).
# Confirmed via a live debugging session in the Collection Routine's
# environment (2026-07-20): the pip-installed playwright package's default
# headless-mode browser revision didn't match what was pre-baked there
# (a fresh `pip install playwright` grabs the latest version, which can
# want a newer browser revision than an older pre-baked cache has) --
# passing this executable_path explicitly bypasses playwright's own
# version-matching and uses the known-working pre-installed browser instead.
# Falls back to playwright's normal resolution (a fresh local install, e.g.
# a dev laptop) when this path doesn't exist.
_PREBAKED_CHROMIUM_PATH = Path("/opt/pw-browsers/chromium")


def _resolve_executable_path() -> str | None:
    if _PREBAKED_CHROMIUM_PATH.exists():
        return str(_PREBAKED_CHROMIUM_PATH)
    return None


# Some cloud Routine environments route outbound HTTPS through a local agent
# proxy (HTTPS_PROXY=http://127.0.0.1:<port>), but Chromium's own network
# stack cannot complete a TLS handshake through it -- every navigation dies
# with net::ERR_CONNECTION_RESET a few seconds after the ClientHello, even
# though the CONNECT tunnel itself succeeds (full writeup:
# docs/COLLECTION_PROXY_ISSUE.md). Standard HTTP client libraries like
# `requests` don't hit this; only the browser's own TLS stack does.
#
# Workaround confirmed via a live diagnostic (2026-07-20), extending a
# community pattern (github.com/anthropics/claude-code#11791) beyond its
# original scope (sub-resources on a localhost dev server) to direct
# top-level navigation on external sites: launch Chromium with
# --no-proxy-server so it never attempts its own outbound connection, and
# intercept every request via page.route(), fulfilling each one with a
# response fetched by `requests` (which respects HTTPS_PROXY normally).
# Real JS still executes locally in the browser -- only the network I/O is
# rerouted. Falls back to direct (unproxied) requests when HTTPS_PROXY isn't
# set, e.g. a dev laptop.
_BLOCKED_RESOURCE_TYPES = {"image", "media", "font"}
_STRIP_REQUEST_HEADERS = {"host", "content-length"}
_STRIP_RESPONSE_HEADERS = {"content-encoding", "content-length", "transfer-encoding", "connection"}


def _build_session() -> requests.Session:
    session = requests.Session()
    proxy_url = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
    )
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
    return session


def _make_route_handler(session: requests.Session) -> Callable[[Route], None]:
    def handle_route(route: Route) -> None:
        request = route.request
        if not request.url.startswith(("http://", "https://")):
            route.continue_()
            return
        if request.resource_type in _BLOCKED_RESOURCE_TYPES:
            route.abort()
            return
        try:
            response = session.request(
                request.method,
                request.url,
                headers={k: v for k, v in request.headers.items() if k.lower() not in _STRIP_REQUEST_HEADERS},
                data=request.post_data_buffer,
                timeout=15,
                allow_redirects=False,
            )
        except requests.RequestException:
            route.abort()
            return
        headers = {k: v for k, v in response.headers.items() if k.lower() not in _STRIP_RESPONSE_HEADERS}
        route.fulfill(status=response.status_code, headers=headers, body=response.content)

    return handle_route

# playwright's default headless UA gets flagged by some sites' bot detection
# (confirmed: libwww.freelibrary.org's Cloudflare challenge blocked the
# default UA, passed cleanly with this one). A realistic desktop-Chrome UA
# is standard practice for legitimate scraping, not evasion of anything
# beyond "looks like an obviously-automated tool."
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Self-resolving bot-challenge interstitials (Cloudflare, WordPress.com/Jetpack,
# etc.) that redirect to real content via JS after a few seconds -- these are
# NOT hard blocks like filmadelphia.org's WAF "Access Denied" page (nothing to
# wait out there). Confirmed hitting one of these live: cinespeak.org (WP.com)
# intermittently showed "Checking your browser..." -- resolved by waiting
# longer, not by anything UA-related (Free Library's Cloudflare case was UA;
# this is a different mechanism). Detect and retry once rather than requiring
# every caller to know to pass --wait-ms.
_CHALLENGE_MARKERS = (
    "checking your browser",
    "just a moment",
    "please wait while we verify",
    "performing security verification",
)
_CHALLENGE_RETRY_WAIT_MS = 6000


def fetch_text(url: str, wait_ms: int, max_chars: int) -> str:
    with sync_playwright() as p:
        executable_path = _resolve_executable_path()
        browser = p.chromium.launch(executable_path=executable_path, args=["--no-proxy-server"])
        page = browser.new_page(user_agent=_USER_AGENT)
        page.route("**/*", _make_route_handler(_build_session()))
        try:
            page.goto(url, wait_until="networkidle", timeout=30_000)
        except PlaywrightTimeoutError:
            # Some pages never go fully idle (polling widgets, analytics
            # beacons, etc.) but did navigate -- fall back to whatever
            # loaded within the wait budget rather than failing the whole
            # fetch. Genuine navigation failures (DNS, connection refused)
            # raise a different (non-Timeout) playwright Error and are
            # deliberately NOT caught here -- those should propagate.
            pass
        if wait_ms:
            page.wait_for_timeout(wait_ms)
        text = page.inner_text("body")
        if any(marker in text.casefold() for marker in _CHALLENGE_MARKERS):
            page.wait_for_timeout(_CHALLENGE_RETRY_WAIT_MS)
            text = page.inner_text("body")
        browser.close()
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n\n[... truncated at {max_chars} chars ...]"
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument(
        "--wait-ms",
        type=int,
        default=0,
        help="Extra wait after networkidle, for pages with post-load JS rendering",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=200_000,
        help="Truncate output beyond this length (safety cap for runaway pages)",
    )
    args = parser.parse_args()

    try:
        text = fetch_text(args.url, args.wait_ms, args.max_chars)
    except Exception as exc:
        print(f"FAILED to fetch {args.url}: {exc}", file=sys.stderr)
        sys.exit(1)

    print(text)


if __name__ == "__main__":
    main()
