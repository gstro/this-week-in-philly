"""Shared proxy-aware requests.Session builder.

Used by both fetch_page_text.py (Chromium route-interception) and
fetch_raw.py (plain HTTP fetch) -- both need to reach real sites through
this environment's HTTPS_PROXY when it's set (docs/COLLECTION_PROXY_ISSUE.md),
and fall back to a direct connection when it isn't, e.g. a dev laptop.
"""

import os

import requests


def build_session() -> requests.Session:
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
