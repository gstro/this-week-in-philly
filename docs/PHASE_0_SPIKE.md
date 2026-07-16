# Phase 0 — Spike & Decide: Runbook & Results

Companion to `docs/V2_IMPLEMENTATION_PLAN.md` Part 3, Phase 0. This is the gating
spike before any cloud (Routines/Actions) work begins on the v2 rewrite — it
confirms or finds fallbacks for every assumption the design makes about the
Routines runtime, and stands up GitHub Pages as the publish target.

**Exit criteria:** every row in the Results table below reads "confirmed" or
names a chosen fallback.

---

## Runbook

1. **Branch:** `phase-0`, cut from `origin/main` (already includes the
   Drive→GitHub pivot, commit `6cbe673`, merged via PR #2 / `2956ed1`).
2. **Spike kit** (this branch): `docs/index.html` (Pages placeholder),
   `spikes/probe.sh` (bash probe of runtime/timezone/secrets/curl/playwright/
   git-push), `spikes/routine-prompt.md` (paste-ready Routine prompt covering
   model ID + Chrome availability + running the probe).
3. **Pages:** merge the placeholder to `main` (Pages serves `docs/` from the
   default branch only), enable Settings → Pages → Deploy from branch → `main`
   `/docs`, confirm repo is public, verify the placeholder serves at
   `https://gstro.github.io/this-week-in-philly/`.
4. **Routine spike:** create a throwaway, manual-trigger Routine against this
   repo. Env vars are configured on the routine's *environment* (a reusable
   config, e.g. "Instrumented"), not per-routine — add `SPIKE_ENV_VAR` there
   as a plaintext propagation check (**not** a secrets test; see "Routine
   secrets gap" below). Attach a Google Calendar connector. Test git-push
   auth (Claude GitHub App write access first; a fine-grained PAT/deploy key
   as `GITHUB_PUSH_TOKEN` as fallback, treated as disposable if used). Paste
   `spikes/routine-prompt.md` as its prompt, run once, collect output.
5. **Record** the results below, update `V2_IMPLEMENTATION_PLAN.md`'s Part 1
   "Minor" cron-timezone note and Phase 0 step 4 answers.
6. **Clean up:** delete the throwaway Routine; confirm no `spike/scratch-*`
   branch remains (`git ls-remote --heads origin 'spike/*'`).

**Status: spike run complete (2026-07-16).** Results below. Two items still
need Pages verification and a real cron fire (see table); everything else is
answered. `spike/scratch-1784237340` (the probe's own leftover branch — its
self-cleanup `git push --delete` failed with the network-access 403 described
below) was deleted manually from a non-sandboxed `git` after the run;
confirmed gone via `git ls-remote --heads origin 'spike/*'`.

---

## Results

**Spike run:** 2026-07-16, one manual throwaway Routine, `claude-sonnet-5`, repo `this-week-in-philly`.

| Question | Expected (design assumption) | Observed | Decision / Fallback |
|---|---|---|---|
| **(critical, new) Can the Routine reach arbitrary external hosts?** | Yes — Collection needs to `web_fetch`/scrape ~29 independent event-source domains | **No.** Outbound network is proxied through a fixed host allowlist (npm, PyPI, jsr, crates, golang proxy, `anthropic.com`). `curl` to `api.github.com` and the playwright CDN (`cdn.playwright.dev`) both got proxy-level `403` ("host not permitted") — a policy block, not a DNS/connectivity failure. This is the environment's "Network access" setting (seen as "Trusted" in the New-environment UI), not a per-request failure. | **Blocks Collection as designed**, independent of the Chrome/playwright question below — even a working scraper can't reach philly-event-source domains under the default allowlist. Must find/set an environment network-access level that permits arbitrary outbound hosts (or an explicit per-domain allowlist covering all ~29 sources) before Collection is buildable. Investigate the "network policy and access levels" docs linked in the New-environment UI; re-test with a widened level before Phase 4. |
| Can a Routine `git push` to the repo? | Yes, via Claude GitHub App write access | **Yes — via ambient credentials**, no `GITHUB_PUSH_TOKEN` needed. A local git relay (`local_proxy@127.0.0.1/git/gstro/this-week-in-philly`) handled auth transparently. Sidesteps the secret-storage question for push auth entirely (see the secrets-gap row below — now narrowed to just `SELECTION_ROUTINE_TOKEN`). **Caveat:** `git push --delete` (ref deletion) got `HTTP 403` — push and delete are asymmetric; no GitHub MCP tool exists to delete a branch either. Cleanup of scratch branches needs a human (or local, non-sandboxed `git`) — confirmed: `spike/scratch-1784237340` was deleted manually from outside the Routine after the run. | Use ambient git push auth for both Collection and Selection Routines — no push-token secret needed. Runbooks/spikes that create scratch branches must document manual cleanup (already reflected in this doc). |
| `get_page_text` / Chrome available in Routines? | Yes | **No — the tool does not exist** in this environment. Only `WebFetch` is available, which fetches + summarizes via a small model rather than returning raw page text — a different mechanism, not a drop-in replacement. | Confirmed: install playwright via setup script (Chrome fallback). **But see the network-access row above — playwright's chromium binary download from `cdn.playwright.dev` is itself blocked by the same host allowlist**, so this fallback is *also* blocked until network access is widened. Add "playwright extraction notes" task to Phase 4 and update `philadelphia-sources/SKILL.md` per-source, contingent on the network fix. |
| Env vars reach the Routine, and can bash `curl` an external API? | Yes | Env var propagation: **Yes** (`SPIKE_ENV_VAR` present, correct length). `curl` to an external API: **No** — same host-allowlist block as above, not a chaining-specific failure (confirms the finding is a blanket network policy, not something scoped only to the playwright CDN). | Collection→Selection `curl` chaining is blocked by the same network-access issue. Once network access is widened for Collection's ~29 sources, re-verify the `SELECTION_ROUTINE_URL` chaining call works too — likely the same fix covers both. |
| **(new) Where do routine-level secrets actually go?** (`GITHUB_PUSH_TOKEN` if GitHub App write access isn't available; `SELECTION_ROUTINE_TOKEN` for the Collection→Selection `curl` trigger) | Design assumed "Routine environment secrets" — **wrong**: the routine environment's "Environment variables" field is plaintext and explicitly shared with anyone using that environment (UI warning: "don't add secrets or credentials") | **Narrowed by this run:** `git push` needs no token at all (ambient credentials cover it — see row above). Only `SELECTION_ROUTINE_TOKEN` (Collection→Selection API trigger) still lacks a confirmed-safe home; the `curl` call to test this was blocked by the network-access issue before the token question could even be reached. | Resolve after the network-access fix: re-test the Collection→Selection curl trigger, and at that point determine where `SELECTION_ROUTINE_TOKEN` should live (a secrets UI not yet found, or a design change e.g. moving to the manifest-existence-guard fallback from the Risk Register, which would eliminate the need for this token entirely). |
| Cron timezone semantics | Unknown — `0 2 * * 0` in UTC would fire Sat 9/10 PM ET (a day early) | **Container clock is UTC** (`date` == `date -u`, `$TZ` unset). This confirms the container's own clock, but not yet the scheduler's cron-trigger semantics (i.e. whether a `cron_expression` fires at that UTC time or is reinterpreted). | Treat `cron_expression` as UTC per the `schedule` skill's own documentation (consistent with this observation) — but confirm with one real scheduled fire before relying on it for the Sunday 2am run, since this run was manually triggered, not cron-fired. |
| Available model IDs | `claude-haiku-4-5` (Collection), `claude-sonnet-4-6` or current equivalent (Selection) | Routine ran as **`claude-sonnet-5`**. No "list available models" tool exists in this environment to enumerate all options; known family from system context: Opus 4.8 (`claude-opus-4-8`), Sonnet 5 (`claude-sonnet-5`), Haiku 4.5 (`claude-haiku-4-5-20251001`), Fable 5 (`claude-fable-5`). `claude-sonnet-4-6` and `claude-haiku-4-5` (undated) from the design/plan docs are stale — the actual IDs have shifted since those docs were written. | Pin Collection to `claude-haiku-4-5-20251001` and Selection to `claude-sonnet-5` at Routine-creation time (Phase 4), not the dated design-doc IDs. Re-check IDs again at that point since this list may itself drift further. |
| GitHub Pages builds and serves `docs/` from `main` | Yes | _pending — verify after placeholder merge to `main`; not exercised by this Routine run_ | Still open — do before closing Phase 0. |

---

## Notes

- The `git push` probe in `spikes/probe.sh` only ever touches a
  `spike/scratch-<timestamp>` branch, never `main` or `data/`, and attempts
  best-effort cleanup of the remote branch after each run.
- Playwright installability is checked regardless of Chrome availability, so
  the fallback path is validated even if Chrome turns out to work — no need
  for a second spike run later if Chrome regresses.
- G8 (public repo exposes personal data) scrub check: nothing added by this
  branch is sensitive, but do the scrub pass before/at the point the repo
  visibility is confirmed public in this phase.
- **Routine env vars are scoped to the environment, not the routine.** The
  "New cloud environment" UI (`claude.ai/code/routines/new`) configures
  environment variables (`.env` format), network access level, and a setup
  script (bash, runs before Claude Code launches — this is the hook for
  installing playwright per the Chrome fallback) once per reusable
  environment (e.g. "Instrumented"), shared across every routine that uses
  it. This confirms the Setup-script mechanism the design's Chrome fallback
  needs, but also surfaces the secrets gap in the row above — env vars there
  are explicitly plaintext and not for secrets/credentials, which contradicts
  `V2_DESIGN.md`'s "inject client ID/secret/refresh token as Routine
  environment secrets" language. Note this doesn't affect the Google/Spotify
  creds used by `presentation.yml` — those run in GitHub Actions with real
  repo secrets, a separate and already-safe mechanism.
- **The environment's default network access level blocks arbitrary outbound
  hosts.** This is the single most consequential finding from the spike run —
  it blocks Collection's ~29 event-source domains, the playwright chromium
  download, and the Collection→Selection `curl` chaining call, all via the
  same proxy-level host allowlist (confirmed via verbose `curl` showing a
  `CONNECT` tunnel rejection, not a DNS/TCP failure). The New-environment UI's
  "Network access" field (seen set to "Trusted") is almost certainly the
  control surface — investigate its other levels and the linked network-policy
  docs before Phase 4. Until this is resolved, Collection cannot be built as
  designed regardless of the Chrome-vs-playwright decision.
- **`git push` needs no stored token** — ambient credentials (a local git
  relay) cover both Collection's and Selection's pushes. This removes
  `GITHUB_PUSH_TOKEN` from the open secrets question entirely; only
  `SELECTION_ROUTINE_TOKEN` remains unresolved, and testing it is blocked on
  the network-access fix above.
- **`git push --delete` is not symmetric with `git push`** — ref deletion via
  the Routine's ambient credentials gets `HTTP 403`, and no GitHub MCP tool
  offers branch deletion either. Any future spike or setup script that creates
  scratch branches must plan for manual (human, or non-sandboxed local `git`)
  cleanup rather than relying on in-Routine self-cleanup.

### Raw probe output (2026-07-16 spike run)

```
=== Phase 0 spike probe :: 2026-07-16T21:28:49Z ===

--- 1. Runtime facts ---
uname:   Linux vm 6.18.5 #1 SMP PREEMPT_DYNAMIC @0 x86_64 x86_64 x86_64 GNU/Linux
python:  Python 3.11.15
git:     git version 2.43.0
pwd:     /home/user/this-week-in-philly
whoami:  root
env vars: 128
PROBE: runtime_facts = PASS  collected above

--- 2. Timezone ---
UTC now:   Thu Jul 16 21:28:49 UTC 2026
local now: Thu Jul 16 21:28:49 UTC 2026
$TZ:       <unset>
PROBE: timezone = PASS  compare against Routine's actual fire time to learn UTC-vs-local

--- 3. Env var propagation ---
PROBE: env_var = PASS  SPIKE_ENV_VAR present, length=7

--- 4. External curl ---
PROBE: external_curl = FAIL  exit=0 http_code=403

--- 5. Playwright ---
playwright not present; attempting install...
PROBE: playwright_installable = FAIL  see /tmp/spike_pw_install.log and /tmp/spike_pw_browser.log

--- 6. git push ---
PROBE: git_push = PASS  pushed to origin/spike/scratch-1784237340 (ambient credentials)
  (cleanup: FAILED to delete remote branch spike/scratch-1784237340 — see /tmp/spike_push_delete.log; delete manually)

=== Probe complete ===
```

Diagnosis beyond the raw PASS/FAIL (from the Routine's own follow-up investigation):
- `external_curl` FAIL: verbose `curl` showed a proxy `CONNECT` tunnel to
  `api.github.com:443` returning `403`; the agent-proxy status endpoint
  reported the same for `cdn.playwright.dev` ("gateway answered 403 to
  CONNECT — policy denial"). Only a fixed allowlist (npm, PyPI, jsr, crates,
  golang proxy, `anthropic.com`) bypasses the proxy.
- `playwright_installable` FAIL: same root cause — `pip install playwright`
  itself succeeded (PyPI is allowlisted); only the chromium binary download
  from `cdn.playwright.dev` was blocked.
- `git push` succeeded via ambient credentials (a local git relay,
  `local_proxy@127.0.0.1/git/gstro/this-week-in-philly`) — no
  `GITHUB_PUSH_TOKEN` was needed.
