"""Tests for scripts/collect_week.py.

Only partial_failure_note() is covered here -- the rest of collect_week.py
is CLI orchestration (real network fetches, filesystem writes) exercised
manually, not in this suite, matching test_collect_source.py's offline/live
split.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from collect_week import partial_failure_note


def test_no_failures_returns_none() -> None:
    assert partial_failure_note([]) is None


def test_one_failure_is_shown_in_full() -> None:
    note = partial_failure_note(["trakt-film-releases calendar page (token=None) (HttpError 500)"])
    assert note == "partial -- 1 request(s) failed: trakt-film-releases calendar page (token=None) (HttpError 500)"


def test_a_few_failures_are_all_shown() -> None:
    note = partial_failure_note(["a (err)", "b (err)", "c (err)"])
    assert note == "partial -- 3 request(s) failed: a (err); b (err); c (err)"


def test_many_failures_are_capped_with_a_remainder_count() -> None:
    """do215's per-day loop can in principle fail every one of a week's 7
    days -- the note must stay bounded rather than growing unboundedly into
    the committed manifest."""
    failures = [f"day-{i} (err)" for i in range(7)]
    note = partial_failure_note(failures)
    assert note == "partial -- 7 request(s) failed: day-0 (err); day-1 (err); day-2 (err); +4 more"
