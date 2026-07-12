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
   repo with a Google Calendar connector, a `SPIKE_SECRET` env secret, and
   git-push auth to test (Claude GitHub App write access first; a
   fine-grained PAT/deploy key as `GITHUB_PUSH_TOKEN` as fallback). Paste
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
| Env secrets reach the Routine, and can bash `curl` an external API? | Yes | _pending spike run_ | If FAIL: Collection→Selection API chaining needs a different mechanism — fallback = scheduled Selection with a manifest-existence guard (per Risk Register). |
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
