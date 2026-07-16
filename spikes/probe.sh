#!/bin/bash
# Phase 0 spike probe — this-week-in-philly v2
#
# One-run probe of every bash-testable unknown blocking the cloud build
# (see docs/PHASE_0_SPIKE.md and docs/V2_IMPLEMENTATION_PLAN.md Part 3, Phase 0).
#
# Deliberately does NOT use `set -e`: every check should run and report,
# even if an earlier one fails. Each result line is greppable:
#   PROBE: <name> = PASS|FAIL|SKIP  <detail>
#
# Env vars (optional):
#   SPIKE_ENV_VAR        — any non-empty value; proves environment-level env vars
#                          propagate into the Routine's shell. NOTE: this is a
#                          propagation check only, not a secrets-storage claim —
#                          the routine environment's env-var config is plaintext
#                          and shared with anyone using that environment (per its
#                          own UI warning), so it is NOT where real secrets
#                          (GITHUB_PUSH_TOKEN, SELECTION_ROUTINE_TOKEN) belong.
#                          See docs/PHASE_0_SPIKE.md for the open question on
#                          where routine-level secrets actually go.
#   GITHUB_PUSH_TOKEN    — PAT/deploy key to test as a git-push auth fallback
#   PROBE_SKIP_PUSH=1    — skip the git push check entirely (safe local dry run)
#   PROBE_PUSH_BRANCH    — override the scratch branch name (default: spike/scratch-<ts>)
set -uo pipefail

pass() { echo "PROBE: $1 = PASS  ${2:-}"; }
fail() { echo "PROBE: $1 = FAIL  ${2:-}"; }
skip() { echo "PROBE: $1 = SKIP  ${2:-}"; }

echo "=== Phase 0 spike probe :: $(date -u +%FT%TZ) ==="
echo

# 1. Runtime facts
echo "--- 1. Runtime facts ---"
echo "uname:   $(uname -a)"
echo "python:  $(python3 --version 2>&1)"
echo "git:     $(git --version 2>&1)"
echo "pwd:     $(pwd)"
echo "whoami:  $(whoami 2>&1)"
echo "env vars: $(env | wc -l | tr -d ' ')"
pass "runtime_facts" "collected above"
echo

# 2. Cron timezone semantics
echo "--- 2. Timezone ---"
echo "UTC now:   $(date -u)"
echo "local now: $(date)"
echo "\$TZ:       ${TZ:-<unset>}"
pass "timezone" "compare against Routine's actual fire time to learn UTC-vs-local"
echo

# 3. Env var propagation (NOT a secrets-storage test — see note above)
echo "--- 3. Env var propagation ---"
if [ -n "${SPIKE_ENV_VAR:-}" ]; then
  pass "env_var" "SPIKE_ENV_VAR present, length=${#SPIKE_ENV_VAR}"
else
  fail "env_var" "SPIKE_ENV_VAR not set or empty"
fi
echo

# 4. External network / curl
echo "--- 4. External curl ---"
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.github.com/zen 2>&1)
CURL_EXIT=$?
if [ "$CURL_EXIT" -eq 0 ] && [ "$HTTP_CODE" = "200" ]; then
  pass "external_curl" "GET api.github.com/zen -> $HTTP_CODE"
else
  fail "external_curl" "exit=$CURL_EXIT http_code=$HTTP_CODE"
fi
echo

# 4b. Real Collection source-domain reachability
# One generic host (api.github.com) passing does NOT prove the ~29 real
# event-source domains are reachable if the widened network access turns out
# to be a curated allowlist rather than fully open. Sample across tiers
# (see docs/v1/Skills/philadelphia-sources/SKILL.md) so a single run answers
# the question that actually matters for Collection.
echo "--- 4b. Source-domain reachability (sample across tiers) ---"
SOURCE_DOMAINS=(
  "philly.askapunk.net"      # Tier 1
  "r5productions.com"        # Tier 2
  "www.philamoca.org"        # Tier 3
  "xpn.org"                  # Tier 3
  "www.meetup.com"           # Tier 4 (iCal)
  "do215.com"                # Tier 5
  "www.songkick.com"         # Tier 5
)
SOURCE_PASS=0
SOURCE_FAIL=0
for domain in "${SOURCE_DOMAINS[@]}"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$domain/" 2>&1)
  if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 500 ]; then
    echo "  $domain -> $code  OK"
    SOURCE_PASS=$((SOURCE_PASS + 1))
  else
    echo "  $domain -> $code  UNREACHABLE"
    SOURCE_FAIL=$((SOURCE_FAIL + 1))
  fi
done
if [ "$SOURCE_FAIL" -eq 0 ]; then
  pass "source_domains" "$SOURCE_PASS/${#SOURCE_DOMAINS[@]} sample domains reachable"
else
  fail "source_domains" "$SOURCE_FAIL/${#SOURCE_DOMAINS[@]} sample domains unreachable — widened access may be an allowlist that doesn't cover all sources"
fi
echo

# 5. Playwright installability (Chrome fallback path)
echo "--- 5. Playwright ---"
if python3 -c "import playwright" >/dev/null 2>&1; then
  pass "playwright_present" "already importable"
else
  echo "playwright not present; attempting install..."
  if pip install --quiet playwright >/tmp/spike_pw_install.log 2>&1 && \
     python3 -m playwright install chromium >/tmp/spike_pw_browser.log 2>&1; then
    pass "playwright_installable" "pip install + chromium install succeeded"
  else
    fail "playwright_installable" "see /tmp/spike_pw_install.log and /tmp/spike_pw_browser.log"
  fi
fi
echo

# 6. git push — the critical unknown
echo "--- 6. git push ---"
if [ "${PROBE_SKIP_PUSH:-0}" = "1" ]; then
  skip "git_push" "PROBE_SKIP_PUSH=1"
else
  BRANCH="${PROBE_PUSH_BRANCH:-spike/scratch-$(date +%s)}"
  SCRATCH_DIR="spikes/_scratch"
  mkdir -p "$SCRATCH_DIR"
  MARKER_FILE="$SCRATCH_DIR/probe-$(date +%s).txt"
  echo "phase-0 git-push probe :: $(date -u +%FT%TZ)" > "$MARKER_FILE"

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ORIG_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if git checkout -q -b "$BRANCH" 2>/dev/null || git checkout -q "$BRANCH" 2>/dev/null; then
      git add "$MARKER_FILE"
      git -c user.name="phase-0-probe" -c user.email="phase-0-probe@local" \
        commit -q -m "spike: git-push probe" >/dev/null 2>&1

      if git push -q origin "HEAD:$BRANCH" 2>/tmp/spike_push.log; then
        AUTH_NOTE="ambient credentials"
        [ -n "${GITHUB_PUSH_TOKEN:-}" ] && AUTH_NOTE="GITHUB_PUSH_TOKEN env secret present"
        pass "git_push" "pushed to origin/$BRANCH ($AUTH_NOTE)"

        # best-effort cleanup of the remote scratch branch
        if git push -q origin --delete "$BRANCH" 2>/tmp/spike_push_delete.log; then
          echo "  (cleanup: remote branch $BRANCH deleted)"
        else
          echo "  (cleanup: FAILED to delete remote branch $BRANCH — see /tmp/spike_push_delete.log; delete manually)"
        fi
      else
        fail "git_push" "push failed — see /tmp/spike_push.log"
      fi

      git checkout -q "$ORIG_BRANCH" 2>/dev/null
      git branch -q -D "$BRANCH" 2>/dev/null
    else
      fail "git_push" "could not create/checkout scratch branch $BRANCH"
    fi
  else
    fail "git_push" "not inside a git work tree"
  fi
  rm -f "$MARKER_FILE"
  rmdir "$SCRATCH_DIR" 2>/dev/null
fi
echo

echo "=== Probe complete ==="
