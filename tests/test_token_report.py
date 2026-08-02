"""Tests for scripts/token_report.py.

Synthetic tmp_path fixtures mimic Claude Code's own transcript layout
(~/.claude/projects/<project>/<session-id>.jsonl + <session-id>/subagents/
*.jsonl + *.meta.json) rather than reading real transcript files -- same
precedent as tests/test_prepare_selection_input.py's synthetic sample week.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from token_report import (
    add_totals,
    build_report,
    default_project_dir,
    find_subagent_transcripts,
    format_report,
    iter_unique_assistant_usages,
    load_agent_meta,
    sum_usage,
    summarize_transcript,
)


def _usage(input_tokens: int = 1, cache_write: int = 0, cache_read: int = 0, output_tokens: int = 1) -> dict:
    return {
        "input_tokens": input_tokens,
        "cache_creation_input_tokens": cache_write,
        "cache_read_input_tokens": cache_read,
        "output_tokens": output_tokens,
    }


def _assistant_line(message_id: str, usage: dict) -> str:
    return json.dumps({"type": "assistant", "message": {"id": message_id, "usage": usage}})


def _write_transcript(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n")


# --- iter_unique_assistant_usages ---


def test_dedupes_repeated_streaming_lines_for_the_same_message_id(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    usage = _usage(input_tokens=5, output_tokens=100)
    _write_transcript(path, [_assistant_line("msg_1", usage), _assistant_line("msg_1", usage), _assistant_line("msg_1", usage)])
    result = iter_unique_assistant_usages(path)
    assert len(result) == 1
    assert result[0]["output_tokens"] == 100


def test_keeps_one_reading_per_distinct_message_id(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write_transcript(path, [_assistant_line("msg_1", _usage(output_tokens=10)), _assistant_line("msg_2", _usage(output_tokens=20))])
    result = iter_unique_assistant_usages(path)
    assert len(result) == 2


def test_ignores_non_assistant_lines(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write_transcript(
        path,
        [
            json.dumps({"type": "user", "message": {"content": "hi"}}),
            _assistant_line("msg_1", _usage(output_tokens=10)),
            json.dumps({"type": "system", "content": "reminder"}),
        ],
    )
    result = iter_unique_assistant_usages(path)
    assert len(result) == 1


def test_skips_blank_and_malformed_lines_rather_than_failing(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write_transcript(path, ["", "not valid json{{{", _assistant_line("msg_1", _usage(output_tokens=10)), "   "])
    result = iter_unique_assistant_usages(path)
    assert len(result) == 1


def test_skips_an_assistant_message_with_no_usage_field(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write_transcript(path, [json.dumps({"type": "assistant", "message": {"id": "msg_1"}})])
    assert iter_unique_assistant_usages(path) == []


# --- sum_usage / summarize_transcript ---


def test_sum_usage_totals_all_four_fields_plus_message_count() -> None:
    usages = [_usage(1, 2, 3, 4), _usage(10, 20, 30, 40)]
    totals = sum_usage(usages)
    assert totals == {
        "input_tokens": 11,
        "cache_creation_input_tokens": 22,
        "cache_read_input_tokens": 33,
        "output_tokens": 44,
        "message_count": 2,
    }


def test_sum_usage_of_empty_list_is_all_zero() -> None:
    totals = sum_usage([])
    assert totals["message_count"] == 0
    assert totals["input_tokens"] == 0


def test_summarize_transcript_dedupes_then_sums(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    usage = _usage(input_tokens=5, output_tokens=100)
    _write_transcript(path, [_assistant_line("msg_1", usage), _assistant_line("msg_1", usage), _assistant_line("msg_2", _usage(output_tokens=50))])
    totals = summarize_transcript(path)
    assert totals["output_tokens"] == 150
    assert totals["message_count"] == 2


# --- add_totals ---


def test_add_totals_combines_two_totals_dicts() -> None:
    a = {"input_tokens": 1, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 3, "output_tokens": 4, "message_count": 5}
    b = {"input_tokens": 10, "cache_creation_input_tokens": 20, "cache_read_input_tokens": 30, "output_tokens": 40, "message_count": 50}
    assert add_totals(a, b) == {
        "input_tokens": 11,
        "cache_creation_input_tokens": 22,
        "cache_read_input_tokens": 33,
        "output_tokens": 44,
        "message_count": 55,
    }


# --- default_project_dir ---


def test_default_project_dir_replaces_slashes_with_dashes() -> None:
    result = default_project_dir(Path("/Users/gstro/local/this-week-in-philly"))
    assert result == Path.home() / ".claude" / "projects" / "-Users-gstro-local-this-week-in-philly"


# --- find_subagent_transcripts / load_agent_meta ---


def test_find_subagent_transcripts_returns_empty_list_when_no_subagents_dir(tmp_path: Path) -> None:
    assert find_subagent_transcripts(tmp_path, "session-1") == []


def test_find_subagent_transcripts_finds_jsonl_files_sorted(tmp_path: Path) -> None:
    subagents_dir = tmp_path / "session-1" / "subagents"
    subagents_dir.mkdir(parents=True)
    (subagents_dir / "agent-b.jsonl").write_text("")
    (subagents_dir / "agent-a.jsonl").write_text("")
    (subagents_dir / "agent-a.meta.json").write_text("{}")
    result = find_subagent_transcripts(tmp_path, "session-1")
    assert [p.name for p in result] == ["agent-a.jsonl", "agent-b.jsonl"]


def test_load_agent_meta_returns_empty_dict_when_no_meta_file(tmp_path: Path) -> None:
    transcript = tmp_path / "agent-a.jsonl"
    transcript.write_text("")
    assert load_agent_meta(transcript) == {}


def test_load_agent_meta_reads_the_sibling_meta_json(tmp_path: Path) -> None:
    transcript = tmp_path / "agent-a.jsonl"
    transcript.write_text("")
    (tmp_path / "agent-a.meta.json").write_text(json.dumps({"agentType": "Explore", "description": "Audit sources"}))
    meta = load_agent_meta(transcript)
    assert meta == {"agentType": "Explore", "description": "Audit sources"}


# --- build_report: end-to-end ---


def _build_session(tmp_path: Path, session_id: str) -> Path:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    main_path = project_dir / f"{session_id}.jsonl"
    _write_transcript(main_path, [_assistant_line("msg_1", _usage(input_tokens=10, cache_write=100, cache_read=1000, output_tokens=50))])

    subagents_dir = project_dir / session_id / "subagents"
    subagents_dir.mkdir(parents=True)
    _write_transcript(subagents_dir / "agent-a.jsonl", [_assistant_line("sub_msg_1", _usage(input_tokens=1, cache_write=10, cache_read=100, output_tokens=5))])
    (subagents_dir / "agent-a.meta.json").write_text(json.dumps({"agentType": "Explore", "description": "Audit sources"}))

    return project_dir


def test_build_report_raises_if_the_main_transcript_is_missing(tmp_path: Path) -> None:
    import pytest

    with pytest.raises(FileNotFoundError):
        build_report(tmp_path, "nonexistent-session")


def test_build_report_includes_session_and_subagent_totals(tmp_path: Path) -> None:
    project_dir = _build_session(tmp_path, "session-1")
    report = build_report(project_dir, "session-1")
    assert report["session_id"] == "session-1"
    assert report["session"]["output_tokens"] == 50
    assert len(report["subagents"]) == 1
    assert report["subagents"][0]["agent_type"] == "Explore"
    assert report["subagents"][0]["description"] == "Audit sources"
    assert report["subagents"][0]["output_tokens"] == 5


def test_build_report_total_sums_session_plus_every_subagent(tmp_path: Path) -> None:
    project_dir = _build_session(tmp_path, "session-1")
    report = build_report(project_dir, "session-1")
    assert report["total"]["output_tokens"] == 55  # 50 (main) + 5 (subagent)
    assert report["total"]["input_tokens"] == 11  # 10 + 1


def test_build_report_with_no_subagents_dir_still_works(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    main_path = project_dir / "session-1.jsonl"
    _write_transcript(main_path, [_assistant_line("msg_1", _usage(output_tokens=10))])
    report = build_report(project_dir, "session-1")
    assert report["subagents"] == []
    assert report["total"]["output_tokens"] == 10


# --- format_report ---


def test_format_report_lists_subagents_sorted_by_total_cost_descending(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    main_path = project_dir / "session-1.jsonl"
    _write_transcript(main_path, [_assistant_line("msg_1", _usage(output_tokens=1))])
    subagents_dir = project_dir / "session-1" / "subagents"
    subagents_dir.mkdir(parents=True)
    _write_transcript(subagents_dir / "agent-small.jsonl", [_assistant_line("s1", _usage(output_tokens=5))])
    _write_transcript(subagents_dir / "agent-big.jsonl", [_assistant_line("s2", _usage(output_tokens=500))])

    report = build_report(project_dir, "session-1")
    output = format_report(report)
    assert output.index("agent-big.jsonl") < output.index("agent-small.jsonl")
    assert "TOTAL" in output
    assert "across 3 transcript(s)" in output
