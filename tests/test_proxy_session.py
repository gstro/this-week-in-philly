"""Tests for scripts/proxy_session.py: explicit proxies must still honor NO_PROXY."""

import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import proxy_session as ps


@pytest.fixture(autouse=True)
def _clean_proxy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(var, raising=False)


def _proxies_for(session: requests.Session, url: str) -> dict[str, str]:
    return session.merge_environment_settings(url, {}, None, None, None)["proxies"]


def test_no_proxy_env_means_no_proxies() -> None:
    assert ps.build_session().proxies == {}


def test_proxy_applied_to_ordinary_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    proxies = _proxies_for(ps.build_session(), "https://do215.com/events")
    assert proxies["https"] == "http://proxy.example:3128"


def test_no_proxy_hosts_bypass_the_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    assert _proxies_for(ps.build_session(), "http://127.0.0.1:8000/sample.json") == {}
