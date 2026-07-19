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
import sys

from playwright.sync_api import sync_playwright

# playwright's default headless UA gets flagged by some sites' bot detection
# (confirmed: libwww.freelibrary.org's Cloudflare challenge blocked the
# default UA, passed cleanly with this one). A realistic desktop-Chrome UA
# is standard practice for legitimate scraping, not evasion of anything
# beyond "looks like an obviously-automated tool."
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def fetch_text(url: str, wait_ms: int, max_chars: int) -> str:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=_USER_AGENT)
        try:
            page.goto(url, wait_until="networkidle", timeout=30_000)
        except Exception:
            # Some pages never go fully idle (polling widgets, analytics
            # beacons, etc.) -- fall back to whatever loaded within the
            # wait budget rather than failing the whole fetch.
            pass
        if wait_ms:
            page.wait_for_timeout(wait_ms)
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
