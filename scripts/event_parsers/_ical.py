"""Shared iCal (RFC 5545) helpers used by luma.py and meetup.py.

Leading underscore: this is a support module, not itself an EventParser --
it has no parse() matching the shared interface, so it's excluded from the
registry in __init__.py.
"""

from __future__ import annotations


def unescape(text: str) -> str:
    return text.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def unfold(raw: str) -> list[str]:
    lines: list[str] = []
    for line in raw.replace("\r\n", "\n").split("\n"):
        if line.startswith(" ") and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    return lines


def parse_vevents(raw: str) -> list[dict[str, str]]:
    lines = unfold(raw)
    events: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in lines:
        if line.startswith("BEGIN:VEVENT"):
            current = {}
        elif line.startswith("END:VEVENT"):
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            key, _, value = line.partition(":")
            field = key.split(";")[0]
            current[field] = value
    return events
