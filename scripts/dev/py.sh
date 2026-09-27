#!/usr/bin/env bash
# Runs a Python dev tool (ruff, mypy, pytest, playwright, python) from the
# repo's .venv when one exists, otherwise from PATH -- so the npm `check:py`
# scripts work the same locally (venv), in CI and in Claude Code cloud
# sessions (tools pip-installed globally). See docs/DEV_ENVIRONMENT.md.
set -euo pipefail
tool="$1"; shift
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -x "$root/.venv/bin/$tool" ]; then
  exec "$root/.venv/bin/$tool" "$@"
fi
exec "$tool" "$@"
