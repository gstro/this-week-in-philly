#!/usr/bin/env python3
"""Fetches a URL's raw response body via a proxy-aware HTTP client and prints it.

Replacement for the AI-summarizing WebFetch tool for sources whose Method in
philadelphia-sources/SKILL.md is "web_fetch" -- plain JSON APIs, iCal feeds,
and simple HTML pages that don't need JS rendering, so a real browser is
unnecessary. WebFetch's own docs note "results may be summarized if the
content is very large", which silently mangles structured payloads (a full
JSON events array, an iCal feed) that need to be parsed exactly as returned,
not paraphrased. This script never puts a model in the loop -- just an HTTP
GET -- so a large events array can't get truncated or hallucinated away.

Proxy handling mirrors fetch_page_text.py: some cloud Routine environments
route outbound HTTPS through a local agent proxy (HTTPS_PROXY), which this
script (like curl, and unlike Chromium's own network stack) respects
natively via `requests`.
"""

import argparse
import sys

from proxy_session import build_session

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def fetch_raw(url: str, max_chars: int) -> str:
    session = build_session()
    response = session.get(url, headers={"User-Agent": _USER_AGENT}, timeout=20)
    response.raise_for_status()
    text = response.text
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n\n[... truncated at {max_chars} chars ...]"
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument(
        "--max-chars",
        type=int,
        default=200_000,
        help="Truncate output beyond this length (safety cap for runaway feeds)",
    )
    args = parser.parse_args()

    try:
        text = fetch_raw(args.url, args.max_chars)
    except Exception as exc:
        print(f"FAILED to fetch {args.url}: {exc}", file=sys.stderr)
        sys.exit(1)

    print(text)


if __name__ == "__main__":
    main()
