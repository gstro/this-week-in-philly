#!/usr/bin/env bash
# SessionStart hook: print a one-line environment status into Claude's
# context. Never installs anything and always exits 0 -- this also runs inside
# the weekly Selection Routine (a cloud session on this repo), which must not
# be slowed down or broken by dev tooling. Heavy installs belong in the cloud
# environment's setup script instead (docs/DEV_ENVIRONMENT.md).
#
# Silent in every cloud session (CLAUDE_CODE_REMOTE=true): the Routine runs no
# npm/Python, and even a descriptive "deps missing" line could nudge it into
# installing things. Dev cloud sessions get their deps from the environment
# setup script instead.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"

missing=""
[ -d "$root/node_modules" ] || missing="$missing node_modules"
if [ ! -d "$root/.venv" ] && ! command -v pytest >/dev/null 2>&1; then
  missing="$missing python-dev-tools"
fi

if [ -n "$missing" ]; then
  echo "[dev-env] local session; not installed:$missing (\`npm run setup\` installs them)."
else
  echo "[dev-env] local session; deps present. Full check: \`npm run check\`."
fi
exit 0
