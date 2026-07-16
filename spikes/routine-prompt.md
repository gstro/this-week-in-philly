# Phase 0 spike — throwaway Routine prompt

Paste this whole file as the prompt for a **manual/one-shot, throwaway** Routine
(see `docs/PHASE_0_SPIKE.md` for setup). Delete the Routine after one run.

---

You are running a one-time infrastructure spike for the `this-week-in-philly`
v2 rewrite. This is **not** a real collection or selection run — do not scrape
events, do not write to `data/`, do not touch anything outside `spikes/`. Your
job is only to answer the questions below and report back. Work through each
step and don't skip any, even if an earlier one fails — report failures too.

## 1. Model identity

Report your own model ID exactly as you know it (e.g. from your system context).
If you have access to a list of available models for this environment, report
that list too.

## 2. Chrome / `get_page_text` availability

Attempt to fetch this page with `get_page_text`:

```
https://r5productions.com/events/
```

- If the tool exists and returns text: paste the **first ~10 lines** of the
  result (enough to confirm it looks like the real event listing, not an error
  page) and note that Chrome is available in this Routine.
- If the tool does not exist, errors, or is unavailable: say so explicitly.
  Don't work around it — the absence itself is the answer we need (it means
  Collection needs the playwright fallback; `spikes/probe.sh` step 5 checks
  whether playwright is installable as that fallback).

## 3. Run the bash probe

Run:

```bash
bash spikes/probe.sh
```

Paste the **entire output** verbatim, including all `PROBE: ... = PASS/FAIL/SKIP`
lines. This checks: runtime facts, cron/timezone info, env-var propagation
(`SPIKE_ENV_VAR` — a plaintext environment variable, not a secret; see below),
external `curl` reachability, playwright installability, and (critically)
whether this Routine can `git push` to the repo — it pushes a throwaway commit
to a scratch branch (`spike/scratch-<timestamp>`) and cleans it up
automatically. It does **not** touch `main` or `data/`.

**Important context on env vars:** the routine environment's "Environment
variables" field is plaintext and explicitly shared with anyone using that
environment (per its own UI warning: "don't add secrets or credentials"). So
`SPIKE_ENV_VAR` only proves env vars *propagate* into the shell — it does not
mean this is a safe place for real secrets like a GitHub push token. If a
`GITHUB_PUSH_TOKEN` was set for this test anyway (to probe the push mechanism
itself), treat it as disposable/already-rotated, not as evidence the env-var
field is an acceptable long-term home for it. If `PROBE: git_push` reports
PASS with no token needed (e.g. the Claude GitHub App already has write
access), that's the preferred outcome — it sidesteps the secret-storage
question for push auth entirely. Report which was true.

## 4. Summarize

Fill in this table with your findings (leave "Observed" blank only if you
could not test something, and say why):

| Question | Observed | Notes |
|---|---|---|
| Model ID | | |
| `get_page_text` / Chrome available? | | |
| Playwright installable (if Chrome unavailable)? | | |
| `git push` to repo works? | | which auth (GitHub App / PAT / neither) |
| Env vars reach the Routine? (propagation only — not a secrets claim) | | |
| Outbound `curl` works? | | |
| Cron timezone (UTC vs local) | | compare fire time to `date -u` from the probe |

Paste this filled-in table as your final message so it can be copied directly
into `docs/PHASE_0_SPIKE.md`.
