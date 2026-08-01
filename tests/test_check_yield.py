"""Tests for scripts/check_yield.py.

tests/fixtures/check_yield/fabricated-2026-07-27/ is the real, committed
data/2026-07-27/ directory (see data/2026-07-27/*.json in git history) --
the actual incident where 17 source files share one fabricated
`collected_at` timestamp. It's used here, not a hand-built fixture, so this
test fails if that specific incident's signature ever stops being detected.
Everything else is small inline data -- the pure check functions don't need
disk I/O to exercise their logic.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from check_yield import (  # noqa: E402
    check_manifest_file_agreement,
    check_non_destructive,
    check_provenance,
    check_yield_floor,
    collect_issues,
    format_report,
)

FIXTURES = Path(__file__).parent / "fixtures" / "check_yield"


def _load_week_dir(week_dir: Path) -> tuple[dict, dict[str, dict], set[str]]:
    with open(week_dir / "_manifest.json") as f:
        manifest = json.load(f)
    source_files = {}
    files_on_disk = set()
    for path in week_dir.glob("*.json"):
        files_on_disk.add(path.name)
        if path.name == "_manifest.json":
            continue
        with open(path) as f:
            source_files[path.stem] = json.load(f)
    return manifest, source_files, files_on_disk


# --- Real incident regression: the fabricated 2026-07-27 week ---


def test_fabricated_week_trips_provenance_check() -> None:
    manifest, source_files, _ = _load_week_dir(FIXTURES / "fabricated-2026-07-27")
    issues = check_provenance(manifest, source_files)

    provenance_issue = next((i for i in issues if i.source is None and "share the identical" in i.message), None)
    assert provenance_issue is not None
    # All 17 real sources that shared the fabricated timestamp.
    for source in [
        "billy-penn", "cinespeak", "do215", "lightbox-film-center",
        "meetup-ai-philly", "meetup-code-coffee", "meetup-dc215", "meetup-horror",
        "meetup-owasp", "meetup-philly-film-club", "meetup-philly-hardware",
        "meetup-tech-in-motion", "philadelphia-citizen", "philly-shows",
        "phillygoth", "songkick", "wxpn",
    ]:
        assert source in provenance_issue.message


def test_fabricated_week_exits_nonzero_via_collect_issues() -> None:
    manifest, source_files, files_on_disk = _load_week_dir(FIXTURES / "fabricated-2026-07-27")
    expected = {"sources": {}, "_meta": {}}  # isolate provenance signal; no yield-floor noise
    issues = collect_issues(manifest, source_files, files_on_disk, expected)
    assert len(issues) >= 1
    assert any(i.check == "provenance" for i in issues)


def test_report_format_is_nonempty_for_real_incident() -> None:
    manifest, source_files, files_on_disk = _load_week_dir(FIXTURES / "fabricated-2026-07-27")
    issues = collect_issues(manifest, source_files, files_on_disk, {"sources": {}, "_meta": {}})
    report = format_report(issues, manifest["week"])
    assert "PROVENANCE" in report
    assert manifest["week"] not in "" # sanity: week string exists
    assert "issue(s) found" in report


# --- Provenance: unit-level ---


def test_provenance_passes_when_timestamps_distinct() -> None:
    manifest = {"run_started": "2026-08-03T02:00:00", "run_completed": "2026-08-03T02:30:00"}
    source_files = {
        "a": {"collected_at": "2026-08-03T02:05:00"},
        "b": {"collected_at": "2026-08-03T02:06:00"},
    }
    assert check_provenance(manifest, source_files) == []


def test_provenance_passes_when_run_window_is_naive_utc_and_sources_are_offset_aware() -> None:
    """Real manifests write run_started/run_completed as naive strings that are
    still UTC in fact (no +00:00 suffix), while collected_at is always offset-aware
    UTC (datetime.now(UTC).isoformat()). Comparing them must normalize to UTC, not
    the local machine's timezone -- this is a real bug caught against real data
    (data/2026-07-20/_manifest.json), where every source false-flagged before the fix."""
    manifest = {"run_started": "2026-07-23T01:32:00", "run_completed": "2026-07-23T01:40:44.675148+00:00"}
    source_files = {"do215": {"collected_at": "2026-07-23T01:40:31.672658+00:00"}}
    assert check_provenance(manifest, source_files) == []


def test_provenance_flags_timestamp_outside_run_window() -> None:
    manifest = {"run_started": "2026-08-03T02:00:00", "run_completed": "2026-08-03T02:30:00"}
    source_files = {"a": {"collected_at": "2026-08-01T00:00:00"}}
    issues = check_provenance(manifest, source_files)
    assert len(issues) == 1
    assert issues[0].source == "a"
    assert "outside this run's" in issues[0].message


# --- Yield floor ---


def test_yield_floor_flags_ok_source_below_documented_minimum() -> None:
    manifest = {"sources": {"do215": {"status": "ok", "events": 0}}}
    expected = {"sources": {"do215": {"min_expected": 4}}, "_meta": {}}
    issues = check_yield_floor(manifest, expected)
    assert len(issues) == 1
    assert issues[0].source == "do215"


def test_yield_floor_does_not_flag_source_with_zero_floor() -> None:
    """Sources documented as genuinely-quiet (min_expected: 0) never trip this check --
    exactly the meetup-owasp / philly-shows case, so a real quiet week isn't cried wolf on."""
    manifest = {"sources": {"meetup-owasp": {"status": "ok", "events": 0}}}
    expected = {"sources": {"meetup-owasp": {"min_expected": 0}}, "_meta": {}}
    assert check_yield_floor(manifest, expected) == []


def test_yield_floor_ignores_failed_sources() -> None:
    # A source that failed outright reports its own failure -- not a silent-zero case.
    manifest = {"sources": {"philadelphia-film-society": {"status": "failed", "reason": "timeout"}}}
    expected = {"sources": {"philadelphia-film-society": {"min_expected": 4}}, "_meta": {}}
    assert check_yield_floor(manifest, expected) == []


def test_total_floor_flags_low_aggregate_even_if_no_single_source_trips() -> None:
    manifest = {"sources": {"a": {"status": "ok", "events": 5}, "b": {"status": "ok", "events": 5}}}
    expected = {"sources": {}, "_meta": {"total_floor": 45}}
    issues = check_yield_floor(manifest, expected)
    assert len(issues) == 1
    assert issues[0].source is None
    assert "whole-run floor" in issues[0].message


# --- Manifest/file agreement ---


def test_file_agreement_flags_count_mismatch() -> None:
    manifest = {"sources": {"do215": {"status": "ok", "events": 3}}}
    source_files = {"do215": {"events": [{"title": "x"}]}}
    issues = check_manifest_file_agreement(manifest, source_files, {"do215.json"})
    assert len(issues) == 1
    assert "3 events but the source file actually contains 1" in issues[0].message


def test_file_agreement_flags_orphaned_file_with_no_manifest_entry() -> None:
    manifest = {"sources": {}}
    source_files = {"do215": {"events": []}}
    issues = check_manifest_file_agreement(manifest, source_files, {"do215.json"})
    assert len(issues) == 1
    assert issues[0].source == "do215"
    assert "no manifest entry" in issues[0].message


def test_file_agreement_flags_missing_file() -> None:
    manifest = {"sources": {"do215": {"status": "ok", "events": 3}}}
    issues = check_manifest_file_agreement(manifest, {}, set())
    assert len(issues) == 1
    assert "no source file found" in issues[0].message


def test_file_agreement_clean_case() -> None:
    manifest = {"sources": {"do215": {"status": "ok", "events": 1}}}
    source_files = {"do215": {"events": [{"title": "x"}]}}
    assert check_manifest_file_agreement(manifest, source_files, {"do215.json"}) == []


# --- Non-destructive re-collection (the 71c6645 incident) ---


def test_non_destructive_flags_regression_to_zero() -> None:
    """Reproduces the real 71c6645 incident: do215 had 11 real events committed,
    a re-collection wrote 0, and the empty file was committed over the real data."""
    prior = {"do215": {"events": [{"title": f"Show {i}"} for i in range(11)]}}
    current = {"do215": {"events": []}}
    issues = check_non_destructive(current, prior)
    assert len(issues) == 1
    assert issues[0].source == "do215"
    assert "erase real data" in issues[0].message


def test_non_destructive_allows_genuinely_empty_to_stay_empty() -> None:
    prior = {"meetup-owasp": {"events": []}}
    current = {"meetup-owasp": {"events": []}}
    assert check_non_destructive(current, prior) == []


def test_non_destructive_allows_non_regressive_change() -> None:
    prior = {"do215": {"events": [{"title": "a"}]}}
    current = {"do215": {"events": [{"title": "a"}, {"title": "b"}]}}
    assert check_non_destructive(current, prior) == []


def test_non_destructive_skipped_when_no_prior_state_given() -> None:
    manifest = {"sources": {"do215": {"status": "ok", "events": 0}}}
    source_files = {"do215": {"events": []}}
    expected = {"sources": {"do215": {"min_expected": 0}}, "_meta": {}}
    # prior_source_files=None (the default) means "no prior git ref to compare" --
    # must not raise, and must not run the non_destructive check.
    issues = collect_issues(manifest, source_files, {"do215.json"}, expected)
    assert issues == []


# --- Real expected_yield.json sanity ---


def test_real_expected_yield_file_is_well_formed_and_exempts_known_quiet_sources() -> None:
    with open(Path(__file__).resolve().parent.parent / "data" / "expected_yield.json") as f:
        expected = json.load(f)

    assert "sources" in expected and "_meta" in expected
    for source, config in expected["sources"].items():
        assert isinstance(config.get("min_expected"), int), source
        assert config["min_expected"] >= 0, source

    for quiet_source in ["meetup-owasp", "meetup-ai-philly", "meetup-philly-film-club", "philly-shows"]:
        assert expected["sources"][quiet_source]["min_expected"] == 0
