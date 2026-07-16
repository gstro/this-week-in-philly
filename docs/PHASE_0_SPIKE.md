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

**Status: two spike runs complete (2026-07-16), with a material disagreement
between them on the network-access finding — see "Run 2" below.** Pages
verification and a real cron fire are still open (see table). `spike/scratch-1784237340`
(Run 1's leftover branch) was deleted manually after Run 1. Run 2 left two
*more* scratch branches undeleted (`spike/scratch-1784238686`,
`spike/scratch-1784239136`) — same push-succeeds/delete-fails asymmetry;
these still need manual cleanup.

---

## Results

### Run 1 — 2026-07-16, one manual throwaway Routine, `claude-sonnet-5`, repo `this-week-in-philly`.

| Question | Expected (design assumption) | Observed | Decision / Fallback |
|---|---|---|---|
| **(critical) Can the Routine reach arbitrary external hosts?** | Yes — Collection needs to `web_fetch`/scrape ~29 independent event-source domains | **Contradictory across two runs same day — unresolved.** Run 1: `curl` to `api.github.com` and `cdn.playwright.dev` got `403`, diagnosed as a proxy-level host allowlist blocking everything outside npm/PyPI/jsr/crates/Go-proxy/`anthropic.com`. Run 2 (~30 min later, same repo): all 7 sampled real Philly source domains returned `200`, and playwright's full chromium download from `cdn.playwright.dev` succeeded end-to-end. Re-diagnosis of Run 2's `api.github.com` 403 shows it's a **GitHub-API repo-scoping response** (`"sessions are bound to their configured repositories"`), not a network block — meaning Run 1's allowlist theory was partly built on a misread of that one signal. No identified variable explains the discrepancy (not `SPIKE_ENV_VAR`, not a change either Routine made). See Run 2 detail below. | **Do not treat either run as final.** Re-run the probe a third time noting the environment's exact network-access-level setting at that moment, so a future discrepancy has a variable to point to. If Run 2's "open" result holds, Collection is buildable as designed with no network-access fix needed; if Run 1's "blocked" result recurs, the original fallback plan (widen network access / explicit per-domain allowlist) still applies. Do not proceed to Phase 4 Collection work until this is settled with a reproducible result. |
| Can a Routine `git push` to the repo? | Yes, via Claude GitHub App write access | **Yes — via ambient credentials**, no `GITHUB_PUSH_TOKEN` needed, confirmed on both runs. A local git relay (`local_proxy@127.0.0.1/git/gstro/this-week-in-philly`) handled auth transparently. Sidesteps the secret-storage question for push auth entirely (see the secrets-gap row below — now narrowed to just `SELECTION_ROUTINE_TOKEN`). **Caveat:** `git push --delete` (ref deletion) got `HTTP 403` on both runs — push and delete are asymmetric; no GitHub MCP tool exists to delete a branch either. Cleanup needs a human (or local, non-sandboxed `git`). Confirmed cleaned up: `spike/scratch-1784237340` (Run 1). **Still outstanding:** `spike/scratch-1784238686` and `spike/scratch-1784239136` (Run 2) — need manual deletion. | Use ambient git push auth for both Collection and Selection Routines — no push-token secret needed. Runbooks/spikes that create scratch branches must document manual cleanup (already reflected in this doc) — this has now happened on every run so far; consider having `probe.sh` print a louder one-line reminder at the very end when delete-cleanup fails, so it isn't easy to miss. |
| `get_page_text` / Chrome available in Routines? | Yes | **No — the tool does not exist** in this environment (confirmed both runs). Only `WebFetch` is available, which fetches + summarizes via a small model rather than returning raw page text — a different mechanism, not a drop-in replacement. | Confirmed: install playwright via setup script (Chrome fallback). Run 1 found the chromium download itself blocked; Run 2 found it succeeds. **Tied to the unresolved network-access question above** — re-verify alongside that third probe run before committing to this fallback in Phase 4. Add "playwright extraction notes" task to Phase 4 and update `philadelphia-sources/SKILL.md` per-source once network access is settled. |
| Env vars reach the Routine, and can bash `curl` an external API? | Yes | Env var propagation: Run 1 **Yes** (`SPIKE_ENV_VAR` present, correct length); Run 2 **not set** (this run's environment config simply didn't have it — not evidence of a propagation regression, since Run 1 already proved propagation works). `curl` to real external domains: Run 1 **No** (everything blocked); Run 2 **Yes**, 7/7 real source domains reachable — see the critical row above. | Collection→Selection `curl` chaining should be re-tested alongside the third network-access probe run — same open question. |
| **(new) Where do routine-level secrets actually go?** (`GITHUB_PUSH_TOKEN` if GitHub App write access isn't available; `SELECTION_ROUTINE_TOKEN` for the Collection→Selection `curl` trigger) | Design assumed "Routine environment secrets" — **wrong**: the routine environment's "Environment variables" field is plaintext and explicitly shared with anyone using that environment (UI warning: "don't add secrets or credentials") | **Narrowed by these runs:** `git push` needs no token at all (ambient credentials cover it — see row above, confirmed twice). Only `SELECTION_ROUTINE_TOKEN` (Collection→Selection API trigger) still lacks a confirmed-safe home; testing it requires the Collection→Selection `curl` call, which is entangled with the still-unresolved network-access question. | Resolve once the network-access question is settled: re-test the Collection→Selection curl trigger, and at that point determine where `SELECTION_ROUTINE_TOKEN` should live (a secrets UI not yet found, or a design change e.g. moving to the manifest-existence-guard fallback from the Risk Register, which would eliminate the need for this token entirely). |
| Cron timezone semantics | Unknown — `0 2 * * 0` in UTC would fire Sat 9/10 PM ET (a day early) | **Container clock is UTC** (`date` == `date -u`, `$TZ` unset), confirmed on both runs. This confirms the container's own clock, but not yet the scheduler's cron-trigger semantics (i.e. whether a `cron_expression` fires at that UTC time or is reinterpreted). | Treat `cron_expression` as UTC per the `schedule` skill's own documentation (consistent with this observation) — but confirm with one real scheduled fire before relying on it for the Sunday 2am run, since both runs so far were manually triggered, not cron-fired. |
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

### Run 2 — 2026-07-16, one manual throwaway Routine, `claude-sonnet-5`, repo `this-week-in-philly`

**This run reverses Run 1's central "network access is blocked" finding.**
Same repo, same day, ~30 minutes later; no change was made to the environment
between runs from inside either Routine. `spikes/probe.sh` had gained step 4b
(real source-domain sampling) between runs, which is what surfaced this.

| Question | Run 1 | Run 2 | 
|---|---|---|
| `external_curl` (`api.github.com/zen`) | FAIL, 403 (diagnosed as proxy policy block) | FAIL, 403 — but see diagnosis below: **not** a network block |
| Real source domains (4b, 7 sampled) | not tested (didn't exist yet) | **PASS, 7/7** (`philly.askapunk.net`, `r5productions.com`, `www.philamoca.org`, `xpn.org`, `www.meetup.com`, `do215.com`, `www.songkick.com` all → 200) |
| `playwright_installable` | FAIL (chromium download blocked) | **PASS** — `pip install playwright` + full chromium (177 MiB) + chrome-headless-shell (114 MiB) downloaded from `cdn.playwright.dev` |
| `env_var` (`SPIKE_ENV_VAR`) | PASS, present | FAIL, not set — this run's environment config didn't have it set; not itself evidence of a propagation regression |
| `git_push` | PASS, ambient credentials, delete-failed (1 leftover branch) | PASS, ambient credentials, delete-failed (1 more leftover branch — 2 now outstanding, see below) |

**Diagnosis (this run):** re-ran `curl -v` against both blocked-looking
targets directly, plus the agent-proxy status endpoint:
- `api.github.com/zen` still returns 403, but the **CONNECT tunnel itself
  succeeds** (`200 Connection Established`) and TLS completes cleanly against
  a real cert (`CN=api.github.com`, issued by `CCR Upstream Proxy CA
  (staging); O=Anthropic` — confirms the proxy is a TLS-terminating MITM, not
  a CONNECT-level blocker). The 403 body is a **GitHub API response**, not a
  proxy error page: `{"message":"This GitHub API path is not available:
  sessions are bound to their configured repositories. Use repository-scoped
  endpoints (repos/{owner}/{repo}/...)."}`. This matches the session's actual
  GitHub scoping (this Routine's GitHub access is explicitly scoped to
  `gstro/this-week-in-philly` — see the repo-scope note in this session's own
  system context) — it is the GitHub proxy enforcing repo scoping, **not**
  a general outbound-network restriction. Run 1's "proxy CONNECT 403 = policy
  denial" diagnosis for this specific target looks like it was a
  misdiagnosis of a GitHub-scoping response, not a network block — worth
  keeping in mind since it means Run 1's "fixed host allowlist" theory was
  built partly on this misread.
- `cdn.playwright.dev/` (bare path, no query params) returns `400
  InvalidQueryParameterValue` from Azure Blob Storage — a real backend
  response (`x-ms-request-id`, `x-azure-ref` headers present), not a proxy
  block. The actual asset URLs playwright's installer requests (with correct
  query params) returned real files and downloaded successfully end-to-end.
- The agent-proxy's own `no_proxy` list (from `curl -v`) includes
  `anthropic.com`, npm/PyPI/jsr/crates/Go proxy, and RFC1918 ranges — i.e.
  those bypass the proxy entirely — but everything else, **including the 7
  source domains and `cdn.playwright.dev`**, is proxied and was NOT rejected
  this run. Nothing in this run's evidence shows a host allowlist blocking
  arbitrary outbound hosts; Run 1's central finding does not reproduce.

**Open question this raises, not yet resolved:** two runs on the same day
gave contradictory answers to "can this Routine reach arbitrary external
hosts" with no identified controlling variable (not the `SPIKE_ENV_VAR`
setting, not an env change either Routine made). Possibilities: (a) the
environment's network-access level was changed by a human between runs, (b)
the two runs used different underlying environments/sandboxes despite the
same repo, or (c) network policy is applied inconsistently. **Before relying
on open outbound access for the real Collection build, re-verify with a
third run, ideally noting the exact environment name/network-access-level
setting at the moment of the run**, so a future discrepancy has a variable to
point to.

**Leftover scratch branches (undeleted, need manual cleanup):**
`spike/scratch-1784238686` (21:51 UTC) and `spike/scratch-1784239136` (21:58
UTC) — both from Run 2's git-push probe (probe.sh was invoked twice in that
session). Same asymmetry as Run 1: `git push` succeeds, `git push --delete`
gets 403, no GitHub MCP tool offers branch deletion. Delete both manually
(non-sandboxed `git push origin --delete spike/scratch-1784238686
spike/scratch-1784239136`) before closing Phase 0.

### Raw probe output (Run 2, 2026-07-16T21:58:14Z)

```
=== Phase 0 spike probe :: 2026-07-16T21:58:14Z ===

--- 1. Runtime facts ---
uname:   Linux vm 6.18.5 #1 SMP PREEMPT_DYNAMIC @0 x86_64 x86_64 x86_64 GNU/Linux
python:  Python 3.11.15
git:     git version 2.43.0
pwd:     /home/user/this-week-in-philly
whoami:  root
env vars: 127
PROBE: runtime_facts = PASS  collected above

--- 2. Timezone ---
UTC now:   Thu Jul 16 21:58:14 UTC 2026
local now: Thu Jul 16 21:58:14 UTC 2026
$TZ:       <unset>
PROBE: timezone = PASS  compare against Routine's actual fire time to learn UTC-vs-local

--- 3. Env var propagation ---
PROBE: env_var = FAIL  SPIKE_ENV_VAR not set or empty

--- 4. External curl ---
PROBE: external_curl = FAIL  exit=0 http_code=403

--- 4b. Source-domain reachability (sample across tiers) ---
  philly.askapunk.net -> 200  OK
  r5productions.com -> 200  OK
  www.philamoca.org -> 200  OK
  xpn.org -> 200  OK
  www.meetup.com -> 200  OK
  do215.com -> 200  OK
  www.songkick.com -> 200  OK
PROBE: source_domains = PASS  7/7 sample domains reachable

--- 5. Playwright ---
playwright not present; attempting install...
PROBE: playwright_installable = PASS  pip install + chromium install succeeded

--- 6. git push ---
PROBE: git_push = PASS  pushed to origin/spike/scratch-1784239136 (ambient credentials)
  (cleanup: FAILED to delete remote branch spike/scratch-1784239136 — see /tmp/spike_push_delete.log; delete manually)

=== Probe complete ===
```
