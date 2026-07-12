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
lines. This checks: runtime facts, cron/timezone info, env secret propagation
(`SPIKE_SECRET`), external `curl` reachability, playwright installability, and
(critically) whether this Routine can `git push` to the repo — it pushes a
throwaway commit to a scratch branch (`spike/scratch-<timestamp>`) and cleans
it up automatically. It does **not** touch `main` or `data/`.

If `PROBE: git_push` reports FAIL, and a `GITHUB_PUSH_TOKEN` secret is
available in this environment, note that so we know to re-run with it set
before concluding the GitHub App path doesn't work.

## 4. Summarize

Fill in this table with your findings (leave "Observed" blank only if you
could not test something, and say why):

| Question | Observed | Notes |
|---|---|---|
| Model ID | | |
| `get_page_text` / Chrome available? | | |
| Playwright installable (if Chrome unavailable)? | | |
| `git push` to repo works? | | which auth (GitHub App / PAT / neither) |
| Env secrets reach the Routine? | | |
| Outbound `curl` works? | | |
| Cron timezone (UTC vs local) | | compare fire time to `date -u` from the probe |

Paste this filled-in table as your final message so it can be copied directly
into `docs/PHASE_0_SPIKE.md`.
