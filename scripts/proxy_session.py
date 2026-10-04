"""Shared proxy-aware requests.Session builder.

Used by both fetch_page_text.py (Chromium route-interception) and
fetch_raw.py (plain HTTP fetch) -- both need to reach real sites through
this environment's HTTPS_PROXY when it's set (docs/COLLECTION_PROXY_ISSUE.md),
and fall back to a direct connection when it isn't, e.g. a dev laptop.
"""

import os
from typing import Any

import requests
from requests.utils import should_bypass_proxies


class _ProxySession(requests.Session):
    """A Session whose explicit `proxies` still honor NO_PROXY.

    requests applies NO_PROXY only to proxies it discovers from the
    environment, not to ones set on `session.proxies`, so loopback and other
    NO_PROXY hosts would otherwise be sent through the proxy.
    """

    def merge_environment_settings(
        self,
        url: str,
        proxies: dict[str, str] | None,
        stream: bool | None,
        verify: bool | str | None,
        cert: str | tuple[str, str] | None,
    ) -> dict[str, Any]:
        settings = super().merge_environment_settings(url, proxies, stream, verify, cert)
        if should_bypass_proxies(url, no_proxy=None):
            settings["proxies"] = {}
        return settings


def build_session() -> requests.Session:
    session = _ProxySession()
    proxy_url = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
    )
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
    return session
