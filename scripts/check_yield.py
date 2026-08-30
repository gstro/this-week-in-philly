#!/usr/bin/env python3
"""Guards against Collection silently reporting zero events as success.

Confirmed live (2026-07-22/23, week of 2026-07-27): 17 of the week's 29
source files carry the *exact same* microsecond `collected_at` timestamp,
each with an empty `events` array and `status: ok` in the manifest. That
timestamp match is not seventeen independent fetches -- it's one write,
copied. The Collection Routine (a model, not this script) skipped the
documented fetch commands for those sources and fabricated plausible-looking
empty results instead of reporting failure. Separately, and more commonly:
sources with no deterministic parser (model reads raw text and picks out
fields itself) have no structural validation at all, so a genuine extraction
failure and a genuinely quiet week produce byte-identical output. Both
failure modes report `status: ok` and pass silently downstream.

This script runs as Collection's last step (after `_manifest.json` is
written) and again in CI on every push touching a manifest. It cannot
prevent a model from skipping a fetch, but it can make sure that never goes
unnoticed: any issue found here exits nonzero, so it lands in the run
summary and in a failed GitHub Actions check -- a check the model runs on
itself can be skipped exactly the way the fetches were; a check in CI
cannot.

Three checks, run independently (a source failing one doesn't skip the others):

  1. Provenance -- duplicate `collected_at` timestamps across source files,
     or a timestamp outside [run_started, run_completed], mean the file
     wasn't produced by a real fetch this run.
  2. Yield floor -- a source at `status: ok` writing fewer events than its
     documented historical floor (data/expected_yield.json) is more likely
     a broken extraction than a quiet week. Sources with no reliable floor
     yet (min_expected: 0) are exempt from this specific check -- the
     provenance check still covers them.
  3. Manifest/file agreement -- every source in the manifest has a file on
     disk, every file's own event count matches what the manifest claims,
     and no source file exists without a manifest entry.

A fourth, optional check (--check-against-ref) compares this run's files
against a prior git ref's committed version of the same week and flags any
source that regressed from a real event count to zero -- the guard for the
71c6645 incident, where a re-collection overwrote 31 real, already-committed
events with empty arrays.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXPECTED_YIELD_PATH = REPO_ROOT / "data" / "expected_yield.json"

# Manifest/candidates/selections/spotify files live alongside source files in
# the same week directory but aren't sources themselves. _candidates.json is
# prepare_selection_input.py's derived output (flattened+deduped candidates
# for Selection) -- regenerable from _manifest.json + the source files, so it
# has no manifest entry of its own and would otherwise trip the orphan-file
# check below. _selection_annotations.json is Selection's own output (the
# id-keyed annotations merge_selections.py turns into _selections.json) --
# same story, no manifest entry, would otherwise trip both the orphan check
# and provenance (which tries to parse every non-exempt *.json as a source).
# _recent_picks.json is prepare_selection_input.py's other derived output (the
# recent weeks' top3 picks, so Selection can avoid repeating them) -- same
# story again, and it ships in the same Collection commit as _manifest.json,
# which is exactly what collection-check.yml triggers on.
NON_SOURCE_FILES = {
    "_manifest.json",
    "_candidates.json",
    "_recent_picks.json",
    "_selection_annotations.json",
    "_selections.json",
    "_spotify.json",
}


@dataclass
class Issue:
    check: str
    source: str | None
    message: str


def _parse_timestamp(value: str) -> datetime:
    # Source files use datetime.now(UTC).isoformat() (offset-aware); manifest
    # run_started/run_completed are sometimes written as naive strings that
    # are still UTC in fact, just missing the +00:00 suffix (confirmed
    # against real manifests: a naive "run_started" and aware "collected_at"
    # timestamps from the same run interleave correctly only under this
    # assumption). Normalize aware timestamps to *UTC*, not the local
    # machine's timezone -- astimezone(tz=None) converts to system local
    # time, which silently corrupts this comparison on any non-UTC machine.
    dt = datetime.fromisoformat(value)  # py3.11+ handles a trailing "Z" natively
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def check_provenance(manifest: dict, source_files: dict[str, dict]) -> list[Issue]:
    issues: list[Issue] = []

    seen_timestamps: dict[str, list[str]] = {}
    for source, content in source_files.items():
        ts = content.get("collected_at")
        if not ts:
            continue
        seen_timestamps.setdefault(ts, []).append(source)

    for ts, sources in seen_timestamps.items():
        if len(sources) > 1:
            issues.append(
                Issue(
                    "provenance",
                    None,
                    f"{len(sources)} source files share the identical collected_at "
                    f"timestamp {ts!r} -- not independent fetches: {', '.join(sorted(sources))}",
                )
            )

    run_started = manifest.get("run_started")
    run_completed = manifest.get("run_completed")
    if run_started and run_completed:
        started: datetime | None
        completed: datetime | None
        try:
            started = _parse_timestamp(run_started)
            completed = _parse_timestamp(run_completed)
        except ValueError:
            started = completed = None
        if started is not None and completed is not None:
            for source, content in source_files.items():
                ts = content.get("collected_at")
                if not ts:
                    continue
                try:
                    collected = _parse_timestamp(ts)
                except ValueError:
                    continue
                if not (started <= collected <= completed):
                    issues.append(
                        Issue(
                            "provenance",
                            source,
                            f"collected_at {ts!r} falls outside this run's "
                            f"[{run_started}, {run_completed}] window",
                        )
                    )

    return issues


def check_yield_floor(manifest: dict, expected: dict) -> list[Issue]:
    issues: list[Issue] = []
    sources_expected = expected.get("sources", {})

    for source, result in manifest.get("sources", {}).items():
        if result.get("status") != "ok":
            continue
        events = result.get("events", 0)
        floor = sources_expected.get(source, {}).get("min_expected", 0)
        if floor > 0 and events < floor:
            issues.append(
                Issue(
                    "yield_floor",
                    source,
                    f"wrote {events} events, below documented floor {floor} "
                    f"(data/expected_yield.json)",
                )
            )

    total_floor = expected.get("_meta", {}).get("total_floor", 0)
    total_events = sum(r.get("events", 0) for r in manifest.get("sources", {}).values())
    if total_floor and total_events < total_floor:
        issues.append(
            Issue(
                "yield_floor",
                None,
                f"total events collected ({total_events}) is below the "
                f"whole-run floor ({total_floor}) -- the run as a whole looks suspect "
                f"even if no single source tripped its own floor",
            )
        )

    return issues


def check_manifest_file_agreement(
    manifest: dict, source_files: dict[str, dict], files_on_disk: set[str]
) -> list[Issue]:
    issues: list[Issue] = []
    manifest_sources = manifest.get("sources", {})

    for source, result in manifest_sources.items():
        if source not in source_files:
            issues.append(Issue("file_agreement", source, "listed in manifest but no source file found on disk"))
            continue
        if result.get("status") != "ok":
            continue
        file_events = source_files[source].get("events", [])
        manifest_events = result.get("events", 0)
        if len(file_events) != manifest_events:
            issues.append(
                Issue(
                    "file_agreement",
                    source,
                    f"manifest claims {manifest_events} events but the source file "
                    f"actually contains {len(file_events)}",
                )
            )

    manifest_filenames = {f"{source}.json" for source in manifest_sources}
    orphaned = files_on_disk - manifest_filenames - NON_SOURCE_FILES
    for filename in sorted(orphaned):
        issues.append(
            Issue("file_agreement", filename[: -len(".json")], "source file exists on disk but has no manifest entry")
        )

    return issues


def check_non_destructive(
    source_files: dict[str, dict], prior_source_files: dict[str, dict]
) -> list[Issue]:
    issues: list[Issue] = []
    for source, prior in prior_source_files.items():
        prior_events = len(prior.get("events", []))
        if prior_events == 0:
            continue
        current = source_files.get(source)
        current_events = len(current.get("events", [])) if current else 0
        if current_events == 0:
            issues.append(
                Issue(
                    "non_destructive",
                    source,
                    f"this run wrote 0 events, but the committed prior version had "
                    f"{prior_events} -- a re-collection must not silently erase real data",
                )
            )
    return issues


def collect_issues(
    manifest: dict,
    source_files: dict[str, dict],
    files_on_disk: set[str],
    expected: dict,
    prior_source_files: dict[str, dict] | None = None,
) -> list[Issue]:
    issues = [
        *check_provenance(manifest, source_files),
        *check_yield_floor(manifest, expected),
        *check_manifest_file_agreement(manifest, source_files, files_on_disk),
    ]
    if prior_source_files is not None:
        issues += check_non_destructive(source_files, prior_source_files)
    return issues


def _load_week_dir(week_dir: Path) -> tuple[dict, dict[str, dict], set[str]]:
    manifest_path = week_dir / "_manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"No _manifest.json in {week_dir}")
    with open(manifest_path) as f:
        manifest = json.load(f)

    source_files: dict[str, dict] = {}
    files_on_disk: set[str] = set()
    for path in week_dir.glob("*.json"):
        files_on_disk.add(path.name)
        if path.name in NON_SOURCE_FILES:
            continue
        source = path.stem
        with open(path) as f:
            source_files[source] = json.load(f)

    return manifest, source_files, files_on_disk


def _git_show_json(ref: str, path: Path) -> dict | None:
    """Returns the JSON content of `path` at git ref `ref`, or None if the
    path doesn't exist at that ref (a new source, or a new week)."""
    rel_path = path.resolve().relative_to(REPO_ROOT)
    result = subprocess.run(
        ["git", "show", f"{ref}:{rel_path.as_posix()}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,  # non-zero just means "doesn't exist at that ref" -- handled below, not an error
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def _load_prior_source_files(week_dir: Path, ref: str, sources: list[str]) -> dict[str, dict]:
    prior: dict[str, dict] = {}
    for source in sources:
        content = _git_show_json(ref, week_dir / f"{source}.json")
        if content is not None:
            prior[source] = content
    return prior


def format_report(issues: list[Issue], week: str) -> str:
    if not issues:
        return f"check_yield: {week} -- no issues found."

    lines = [f"check_yield: {week} -- {len(issues)} issue(s) found:"]
    by_check: dict[str, list[Issue]] = {}
    for issue in issues:
        by_check.setdefault(issue.check, []).append(issue)

    labels = {
        "provenance": "PROVENANCE (fabricated / unfetched)",
        "yield_floor": "YIELD FLOOR (suspiciously low)",
        "file_agreement": "MANIFEST/FILE MISMATCH",
        "non_destructive": "DESTRUCTIVE RE-COLLECTION",
    }
    for check, check_issues in by_check.items():
        lines.append(f"\n{labels.get(check, check)}:")
        for issue in check_issues:
            prefix = f"  [{issue.source}] " if issue.source else "  "
            lines.append(f"{prefix}{issue.message}")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("week_dir", type=Path, help="e.g. data/2026-08-03")
    parser.add_argument(
        "--expected",
        type=Path,
        default=DEFAULT_EXPECTED_YIELD_PATH,
        help="Path to expected_yield.json (default: data/expected_yield.json)",
    )
    parser.add_argument(
        "--check-against-ref",
        default=None,
        help="Git ref (e.g. HEAD) to compare against for the non-destructive-recollection "
        "check. Omit to skip that check (e.g. for a brand-new week with no prior commit).",
    )
    args = parser.parse_args()

    week_dir: Path = args.week_dir
    manifest, source_files, files_on_disk = _load_week_dir(week_dir)

    with open(args.expected) as f:
        expected = json.load(f)

    prior_source_files = None
    if args.check_against_ref:
        prior_source_files = _load_prior_source_files(
            week_dir, args.check_against_ref, list(manifest.get("sources", {}))
        )

    issues = collect_issues(manifest, source_files, files_on_disk, expected, prior_source_files)

    print(format_report(issues, manifest.get("week", week_dir.name)))
    if issues:
        sys.exit(1)


if __name__ == "__main__":
    main()
