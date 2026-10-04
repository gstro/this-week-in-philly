"""Tests for scripts/ci/selection_merge_guard.sh.

The guard decides whether selection-merge.yml may merge a pushed claude/*
branch without a human looking at it, so each decline branch is pinned here.
Every test builds a throwaway git repo (a real one, not a mock) with a `main`
base and a `branch` head, then runs the script exactly as the workflow does.
"""

import subprocess
from pathlib import Path

import pytest

GUARD = Path(__file__).resolve().parent.parent / "scripts" / "ci" / "selection_merge_guard.sh"
WEEK = "data/2026-10-12"
ANNOTATIONS = f"{WEEK}/_selection_annotations.json"
CANDIDATES = f"{WEEK}/_candidates.json"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def _write(repo: Path, rel: str, content: str = "{}\n") -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def _commit(repo: Path, message: str) -> None:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)


def _make_repo(tmp_path: Path, base_files: list[str]) -> Path:
    """A repo whose `main` holds base_files, with `branch` checked out from it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _write(repo, "README.md", "base\n")
    for rel in base_files:
        _write(repo, rel)
    _commit(repo, "base")
    _git(repo, "checkout", "-q", "-b", "branch")
    return repo


def _run_guard(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(GUARD), "main", "branch"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )


def test_accepts_new_annotations_when_candidates_on_base(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path, [CANDIDATES])
    _write(repo, ANNOTATIONS)
    _commit(repo, "selection")

    result = _run_guard(repo)

    assert result.returncode == 0, result.stdout
    assert result.stdout.strip() == WEEK


def test_declines_when_candidates_missing_on_base(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path, [])
    _write(repo, ANNOTATIONS)
    _commit(repo, "selection")

    result = _run_guard(repo)

    assert result.returncode == 1
    assert "_candidates.json is not on main" in result.stdout


def test_declines_when_candidates_only_added_on_the_branch(tmp_path: Path) -> None:
    # Collection must have landed on base; adding both files on the branch is
    # also two changed files, so it is declined on the file-count rule.
    repo = _make_repo(tmp_path, [])
    _write(repo, ANNOTATIONS)
    _write(repo, CANDIDATES)
    _commit(repo, "selection + candidates")

    result = _run_guard(repo)

    assert result.returncode == 1
    assert "found 2" in result.stdout


def test_declines_edit_to_existing_annotations(tmp_path: Path) -> None:
    # The PR #26 case: modifying a historical week's annotations is a backfill.
    repo = _make_repo(tmp_path, [CANDIDATES, ANNOTATIONS])
    _write(repo, ANNOTATIONS, '{"edited": true}\n')
    _commit(repo, "backfill")

    result = _run_guard(repo)

    assert result.returncode == 1
    assert "status 'M'" in result.stdout


def test_declines_when_nothing_changed(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path, [CANDIDATES])

    result = _run_guard(repo)

    assert result.returncode == 1
    assert "found 0" in result.stdout


def test_declines_multiple_files(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path, [CANDIDATES])
    _write(repo, ANNOTATIONS)
    _write(repo, "scripts/other.py", "x = 1\n")
    _commit(repo, "selection + stray change")

    result = _run_guard(repo)

    assert result.returncode == 1
    assert "found 2" in result.stdout


@pytest.mark.parametrize(
    "bad_path",
    [
        f"{WEEK}/_selections.json",
        "data/2026-10-12/_candidates/extra.json",
        "data/not-a-week/_selection_annotations.json",
        "docs/_selection_annotations.json",
    ],
)
def test_declines_wrong_path(tmp_path: Path, bad_path: str) -> None:
    repo = _make_repo(tmp_path, [CANDIDATES])
    _write(repo, bad_path)
    _commit(repo, "wrong file")

    result = _run_guard(repo)

    assert result.returncode == 1
    assert "is not a week's _selection_annotations.json" in result.stdout
