# Selection's token usage: what it actually costs and what didn't help

## Summary

Selection is the only LLM stage in the pipeline, and its cost wasn't obvious until measured. Two
findings, in order:

1. **Selection was re-transcribing its own input.** Of the ~500 events that joined back to a
   candidate in a real run, `title`/`venue`/`time`/`cost`/`url`/`source` were copied **verbatim**
   (498-500 of 500 each) into `_selections.json` — the model retyping data it was just handed, to
   attach four small judgment fields (`category`, `is_music`, `sold_out`, `note`). Fixed by having
   Selection write only the judgment calls, keyed by a candidate's stable `id`, and reconstructing
   the rest deterministically in a new merge step (`scripts/merge_selections.py`, run in GitHub
   Actions, not the LLM session).
2. **Per-day subagent fan-out — which looked like the obvious way to exploit the resulting per-day
   candidate split, and which an early real run chose on its own — measured out to be a net loss,
   not a win.** Real local measurement (same week, same skill, processed both ways) showed fan-out
   costing ~3x more output tokens and, after weighting for relative token price, ~38% more total
   cost than one continuous session doing all 7 days sequentially. Neither of the two obvious fixes
   (share context between subagents; make subagents terser) closes the gap: Claude Code's
   context-sharing mechanism (`fork`) is confirmed CLI-only, unavailable to the Routine this skill
   actually runs under in production. `.claude/skills/philly-events-selection/SKILL.md` now
   explicitly forbids subagent dispatch instead of leaving it to the Routine's discretion.

Everything below is on the `token-optimization` branch (commits `c686af1`..`8fec1ec`), not yet
merged to `main`. `_selections.json`'s schema, as seen by the four downstream consumer scripts
(`html_render.py`, `calendar_create.py`, `spotify_lookup.py`, `csv_log.py`), is **unchanged** —
everything here is upstream of that contract.

## Evidence

### Where the tokens were going (real 2026-08-03 week, before any change)

| What | Size | Note |
|---|---|---|
| `_candidates.json` (input) | ~86k tok | of which **`description` is 55%** (~48k) |
| `_selections.json` (output) | ~59k tok | of which **`events[]` is 90%** (~54k) |
| `event-selection-philosophy` + `personal-interests` skills | **~1.2k tok** | ×7 day-agents ≈ **8k, ~4% of a run** |

The skills being re-read per day-agent — the original suspicion that prompted this investigation —
turned out to be a rounding error. The real costs were the monolithic input file and Selection
re-typing most of its own output.

Collected volume is also not what the system was designed around: `2026-07-20 = 67` events
(do215 broken that week), `2026-07-27 = 40`, **`2026-08-03 = 642`** (do215 alone = 517). CLAUDE.md
still describes the pipeline as collecting "~245 events" — that's been wrong since do215's parser
was fixed (see `docs/COLLECTION_YIELD_INVESTIGATION.md`), which also 2.6x'd Selection's real input
size as an unplanned side effect.

### Two bugs the old schema was quietly causing

1. **Title drift.** 62 of 562 events in a real `_selections.json` did not join back to any
   candidate by exact title string — Selection had silently reworded some titles in transit.
   `html_render.py`'s ⭐ marking and the Spotify/calendar lookups all key off exact title match, so
   this was a real (if usually invisible) defect, not just waste. Resolving `top3`/
   `honorable_mentions`/`events[]` from the same candidate `id` makes this structurally impossible.
2. **Time corruption.** 5 of 21 real Top 3 picks lost their calendar event silently because
   `calendar_create.py`'s `parse_start()` only matches a single `H:MM AM/PM` string, and Selection
   had written a list, a doors/show pair, or a range into `time` instead. Investigating this for the
   new schema (which copies `time` verbatim from the candidate by default) found the causes split
   roughly evenly between genuinely malformed raw Collection data (e.g. `"7:00, 7:30"`, no AM/PM)
   and Selection itself introducing the mess on an otherwise-clean value — so the new schema keeps a
   narrow, optional `time` override on `top3` picks only, restoring the old capability without
   paying for it on the ~95% of picks that don't need it.

### Fan-out vs. single-session, measured for real

Built `scripts/token_report.py` to parse local Claude Code session transcripts
(`~/.claude/projects/<project>/<session-id>.jsonl` + `.../subagents/*.jsonl`) into a per-stage
breakdown — the Routine API itself exposes no per-session token telemetry. One real wrinkle:
assistant messages are logged multiple times as they stream (a 12MB real session had 2287
assistant-type lines but only 1227 unique message ids, with identical final usage numbers on every
duplicate) — the parser dedupes by message id first, confirmed empirically before trusting it.

Two scenarios, same real week (2026-08-03, 561 candidates, 21 real Top 3 picks selected, 102
candidates annotated), same skill on this branch, real judgment (not synthetic annotations):

| | Scenario A — 7 subagents (fan-out) | Scenario B — 1 session, no fan-out |
|---|---|---|
| input | 48 | 46 |
| cache_write | 507,902 | 292,107 |
| cache_read | 851,312 | 3,674,350 |
| **output** | **189,282** | **61,318** |
| merges clean, all stars resolve | yes | yes |

Output is ~3x lower with no fan-out. Most of Scenario A's output wasn't the compact annotation
JSON — it was each subagent narrating its picks back to its parent in prose, redundant with the
`why`/`note` fields already inside the JSON it was writing.

Raw total tokens look worse for Scenario B (4.0M vs 1.5M) only because `cache_read` — priced far
below a fresh `cache_write` or plain `input` token — dominates one long session re-reading its own
growing context. Weighting each field by illustrative relative price (`cache_write` ~1.25x input,
`cache_read` ~0.1x input, `output` ~5x input — approximate multipliers, not exact billed pricing)
puts Scenario B at **~1.04M weighted units vs Scenario A's ~1.67M — ~38% cheaper**. This likely
understates the real gap: Scenario A's own orchestration overhead (dispatch, collection, assembly)
is excluded entirely from that comparison, because its main-session transcript was contaminated by
an unrelated earlier failure (see below) and only the 7 subagent transcripts — spawned fresh after
the correction — were usable.

### A real hazard specific to this machine, hit during measurement

The first local run of the new skill silently used the wrong skill entirely: this machine also has
the real, currently-running **v1** production skill on disk
(`/Users/gstro/Documents/Claude/Scheduled/philly-events-selection/SKILL.md`, prerequisites on a
mounted volume at `/Volumes/molo/Documents/Claude/Skills/`) — a session that searches the
filesystem for something named "philly-events-selection" instead of using this repo's project skill
finds those real files and runs v1 instead. It looked like it worked (wrote a file named
`_selection_annotations.json`, reported real-looking counts) but v1 still does its own dedup phase
(which v2 deliberately removed — `prepare_selection_input.py` owns it now) and writes the full old
`_selections.json` shape with every field re-typed, silently defeating the entire point of the
schema change. No repo-relative skill path is safe from this on this machine without saying so
explicitly and ruling out every other location.

### Why fan-out can't be fixed by trimming narration alone

Researched whether the ~508k combined `cache_write` cost (each of the 7 subagents independently
paying to establish system prompt + tool definitions + skill files, none of it shared between
siblings) could be avoided:

- **`fork`-style context inheritance — the mechanism that lets a Claude Code subagent inherit its
  parent's already-cached context — is a CLI-only feature.** Confirmed via Anthropic's own docs, not
  inferred: subagents dispatched by the Agent SDK or API layer (which is what a Routine runs on)
  explicitly do not inherit the parent's conversation history or tool results and build their own
  cache from zero. A Routine's own subagent dispatch has no access to fork.
- **Cross-request prompt-cache sharing is real independent of fork** — Anthropic's cache is
  prefix-matched at the API level, workspace-scoped, 5-minute default TTL, and doesn't require "same
  conversation." In principle, if a parent read the shared skill files first and subagents fired
  shortly after reconstructing an identical prefix, some of that cost could land as cheap
  `cache_read` instead. Whether a Routine's actual subagent dispatch would reconstruct a
  byte-identical shared prefix (any per-agent text inserted before the shared content breaks the
  match), and whether near-simultaneous dispatch races ahead of the first write landing, are both
  undocumented and outside what a SKILL.md can control or verify.

Net: the one clean, controllable fix doesn't exist in this environment; the other is real but
unverifiable and not something a skill file can force. Narration itself is reducible with an
explicit "JSON only" instruction, but even a perfectly silent subagent still can't close the
`cache_write` gap — so the fix was to stop fanning out, not to make fan-out leaner.

## Changes made

- **`scripts/prepare_selection_input.py`** (`c686af1`) — stable `c0000`-style `id` per candidate;
  `description` capped at 600 chars on emit (keeps full text for ~90% of events, p90 was 751 chars);
  `--split-by-day` writes `data/<week>/_candidates/<date>.json` alongside the existing monolithic
  file. Verified `check_yield.py`'s orphan check doesn't see the new subdirectory (its glob is
  non-recursive) and that a candidate whose date falls outside the target week now raises instead
  of silently vanishing from the per-day split.
- **`scripts/merge_selections.py`** (new, `f2e818d`, hardened `9e02484`) — deterministic merge of
  `_candidates.json` + Selection's `_selection_annotations.json` into `_selections.json`. Fails
  loudly on an unknown id, a non-canonical category, or a `top3`/`honorable_mentions` id absent from
  that day's own annotations; `sold_out`/`is_music` default to `false` rather than being required,
  since requiring an occasionally-false boolean on ~350 annotations a week would fail the whole
  merge over one omission. Restores the honorable-mention `(SOLD OUT)` title suffix
  `html_render.py` bolds, which the verbatim-copy schema would otherwise have silently dropped.
  `presentation.yml` runs this as its first step, before `runner.sh`, and its trigger is repointed
  from `_selections.json` to `_selection_annotations.json` — a separate merge-and-push workflow
  would push with `GITHUB_TOKEN`, which doesn't retrigger `on: push`. Also added the missing
  `branches: [main]` filter on that trigger, closing the gap that let a scratch-branch push fire a
  real, unintended Google Calendar write during an earlier investigation.
- **`.claude/skills/philly-events-selection/SKILL.md`** (`411262e`, `8fec1ec`) — reads per-day
  candidate files instead of the monolithic one; writes only `_selection_annotations.json`
  (judgment calls keyed by id); caps annotation at 10 candidates per category per day (Top 3 and
  honorable mentions always kept regardless); states the nine canonical categories inline so a
  day-agent never opens `events-report-format/SKILL.md` just to sort; explicitly forbids subagent
  dispatch.
- **`scripts/token_report.py`** (new, `965d553`) — parses local session transcripts into a
  per-subagent token breakdown; the tool this whole investigation's real numbers came from.

## Remaining work

- **No real end-to-end verification yet.** Everything above is verified against real archived data
  in scratch directories outside `data/` (merge fidelity, schema correctness, all 21 stars
  resolving) and against real local Selection runs for the token measurements — but not against a
  real `workflow_dispatch` Collection run feeding a real Selection Routine run feeding a real
  `presentation.yml` fire, on this branch. That's the next real-pipeline test before merging to
  `main`.
- **CLAUDE.md's "~245 events" description** is still wrong — collected volume is genuinely ~640 now;
  with the per-category cap the *listed* count lands near the old baseline again, but *collected*
  does not.
- A standing `check_yield`-style assertion that every `top3` title appears verbatim in its day's
  `events[]` would catch a future regression of the title-drift bug even after this fix.
- Attendance/picks-log loop and multi-artist Spotify links remain deferred (out of scope here, not
  forgotten).
