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

---

## Results

| Question | Expected (design assumption) | Observed | Decision / Fallback |
|---|---|---|---|
| Can a Routine `git push` to the repo? | Yes, via Claude GitHub App write access | _pending spike run_ | If FAIL with App: retry with PAT/deploy key (`GITHUB_PUSH_TOKEN`). If both fail: Routine calls the GitHub REST contents API instead of shelling out to `git`. |
| `get_page_text` / Chrome available in Routines? | Yes | _pending spike run_ | If unavailable: install playwright via setup script; add a "playwright extraction notes" task to Phase 4 and update `philadelphia-sources/SKILL.md` per-source. |
| Env vars reach the Routine, and can bash `curl` an external API? | Yes | _pending spike run_ | If FAIL: Collection→Selection API chaining needs a different mechanism — fallback = scheduled Selection with a manifest-existence guard (per Risk Register). |
| **(new) Where do routine-level secrets actually go?** (`GITHUB_PUSH_TOKEN` if GitHub App write access isn't available; `SELECTION_ROUTINE_TOKEN` for the Collection→Selection `curl` trigger) | Design assumed "Routine environment secrets" — **wrong**: the routine environment's "Environment variables" field is plaintext and explicitly shared with anyone using that environment (UI warning: "don't add secrets or credentials") | _pending spike run — confirmed via UI screenshot 2026-07-16 that env vars are plaintext/shared; no dedicated secrets store found yet_ | Best case: Claude GitHub App already has write access to the repo, so no push token is needed at all — check this first. If a token is unavoidable, it needs a different home than the environment's env-var box (per-connector auth? a distinct secrets UI not yet found?) — resolve before Phase 3/4, since GitHub Actions secrets (used for Google/Spotify creds) are a separate, already-safe mechanism and unaffected by this gap. |
| Cron timezone semantics | Unknown — `0 2 * * 0` in UTC would fire Sat 9/10 PM ET (a day early) | _pending spike run_ | Set the actual cron expression in Phase 4 accounting for the observed offset. |
| Available model IDs | `claude-haiku-4-5` (Collection), `claude-sonnet-4-6` or current equivalent (Selection) | _pending spike run_ | Pin Routine model IDs at creation time against whatever list the spike returns (per Part 1 "Minor" note). |
| GitHub Pages builds and serves `docs/` from `main` | Yes | _pending — verify after placeholder merge_ | N/A if confirmed. |

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
