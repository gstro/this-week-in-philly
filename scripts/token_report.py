#!/usr/bin/env python3
"""Per-stage / per-subagent token usage breakdown for a local Claude Code
session, parsed from that session's own transcript files.

Phase 4 of the Selection token-reduction plan: the Claude Code Routine API
(RemoteTrigger's list/get/create/update/run) exposes no per-session token
telemetry, so there's no way to measure a scheduled Selection run's real
cost directly. A LOCAL session transcript does carry it -- every assistant
message logs input_tokens/cache_creation_input_tokens/cache_read_input_tokens/
output_tokens, and a spawned subagent (e.g. one day-agent) writes its own
transcript file under the parent session's directory. So: run Selection
locally (not as a Routine) to get a real, per-subagent breakdown this script
can parse -- see the plan's Phase 4 verification step.

Layout, Claude Code's own convention (not something this script invents):
  ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl        (main session)
  ~/.claude/projects/<...>/<session-id>/subagents/agent-<id>.jsonl         (one per subagent)
  ~/.claude/projects/<...>/<session-id>/subagents/agent-<id>.meta.json     (agentType/description)

Each assistant message is logged multiple times as it streams (2287 lines
but only 1227 unique message ids in a real 12MB session transcript checked
while building this) -- token counts are already final and identical across
a given id's duplicate lines, confirmed empirically, so this dedupes by
message id and keeps one usage reading per unique message.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

# The four fields every assistant message's `usage` object carries and this
# report sums. cache_creation's ephemeral_5m/1h sub-split and server_tool_use
# aren't broken out -- not needed for a token-cost breakdown.
USAGE_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


def iter_unique_assistant_usages(path: Path) -> list[dict[str, int]]:
    """One usage dict per unique assistant message id in `path`, in first-seen
    order. Skips malformed/blank lines rather than failing the whole report
    over one bad line -- this reads a live, append-only log file, not a
    controlled pipeline artifact."""
    by_id: dict[str, dict[str, int]] = {}
    order: list[str] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") != "assistant":
                continue
            message = entry.get("message", {})
            message_id = message.get("id")
            usage = message.get("usage")
            if message_id is None or usage is None:
                continue
            if message_id not in by_id:
                order.append(message_id)
            by_id[message_id] = usage
    return [by_id[message_id] for message_id in order]


def sum_usage(usages: list[dict[str, Any]]) -> dict[str, int]:
    totals = dict.fromkeys(USAGE_FIELDS, 0)
    for usage in usages:
        for field in USAGE_FIELDS:
            totals[field] += usage.get(field) or 0
    totals["message_count"] = len(usages)
    return totals


def add_totals(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {field: a.get(field, 0) + b.get(field, 0) for field in (*USAGE_FIELDS, "message_count")}


def summarize_transcript(path: Path) -> dict[str, int]:
    return sum_usage(iter_unique_assistant_usages(path))


def default_project_dir(cwd: Path | None = None) -> Path:
    """Claude Code's own convention: the project directory name is the
    absolute cwd path with every "/" replaced with "-"."""
    cwd = (cwd or Path.cwd()).resolve()
    slug = str(cwd).replace("/", "-")
    return Path.home() / ".claude" / "projects" / slug


def find_subagent_transcripts(project_dir: Path, session_id: str) -> list[Path]:
    subagents_dir = project_dir / session_id / "subagents"
    if not subagents_dir.exists():
        return []
    return sorted(subagents_dir.glob("*.jsonl"))


def load_agent_meta(subagent_transcript: Path) -> dict[str, Any]:
    meta_path = subagent_transcript.with_suffix(".meta.json")
    if not meta_path.exists():
        return {}
    return json.loads(meta_path.read_text())  # type: ignore[no-any-return]


def build_report(project_dir: Path, session_id: str) -> dict[str, Any]:
    main_path = project_dir / f"{session_id}.jsonl"
    if not main_path.exists():
        raise FileNotFoundError(f"No session transcript at {main_path}")

    session_totals = summarize_transcript(main_path)

    subagents = []
    for path in find_subagent_transcripts(project_dir, session_id):
        meta = load_agent_meta(path)
        subagents.append(
            {
                "file": path.name,
                "agent_type": meta.get("agentType", ""),
                "description": meta.get("description", ""),
                **summarize_transcript(path),
            }
        )

    total = session_totals
    for subagent in subagents:
        total = add_totals(total, subagent)

    return {
        "session_id": session_id,
        "session": session_totals,
        "subagents": subagents,
        "total": total,
    }


def format_report(report: dict[str, Any]) -> str:
    def row(label: str, totals: dict[str, int], suffix: str = "") -> str:
        return (
            f"  {label:<28} input={totals['input_tokens']:>7}  cache_write={totals['cache_creation_input_tokens']:>9}  "
            f"cache_read={totals['cache_read_input_tokens']:>10}  output={totals['output_tokens']:>8}  "
            f"({totals['message_count']} msg){suffix}"
        )

    lines = [f"Session: {report['session_id']}", row("main session", report["session"])]

    by_cost = sorted(
        report["subagents"],
        key=lambda a: -(a["input_tokens"] + a["cache_creation_input_tokens"] + a["cache_read_input_tokens"] + a["output_tokens"]),
    )
    for agent in by_cost:
        label = agent["agent_type"] or agent["file"]
        suffix = f" -- {agent['description']}" if agent["description"] else ""
        lines.append(row(f"  {label}", agent, suffix))

    lines.append(row("TOTAL", report["total"], f" across {1 + len(report['subagents'])} transcript(s)"))
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("session_id", help="Session UUID -- the .jsonl filename under ~/.claude/projects/<project>/, minus the extension")
    parser.add_argument("--project-dir", type=Path, default=None, help="Defaults to ~/.claude/projects/<cwd-slug>")
    parser.add_argument("--json", action="store_true", help="Emit the full report as JSON instead of a formatted table")
    args = parser.parse_args()

    project_dir = args.project_dir or default_project_dir()
    report = build_report(project_dir, args.session_id)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(format_report(report))


if __name__ == "__main__":
    main()
