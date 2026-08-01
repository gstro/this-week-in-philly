# Golden test fixtures

`2026-06-22.html` is the real HTML report v1 produced for the week of
2026-06-22, supplied directly by Greg from his local archive. It's the
reference used to validate `scripts/html_render.py` against actual
production output (not just the `events-report-format/SKILL.md` spec).

`actual-2026-06-22.html` is `html_render.py`'s own committed output for the
same week, and is what `tests/test_html_render.py`'s golden test
(`test_render_report_matches_the_golden_v2_artifact`) pins byte-for-byte —
the "golden test" `V2_IMPLEMENTATION_PLAN.md` promised in four places
(`:62`, `:119`, `:192`, `:233`) but was never actually written until that
test landed. This file **is not** meant to match `2026-06-22.html`; see
Known, deliberate divergences below for why. When `html_render.py` changes
on purpose, regenerate this file and review the diff before committing it —
it's supposed to move only when the renderer's actual output does.

The corresponding source data lives at `data/2026-06-22/`:
- `_selections.json` — the real Selection-stage output for that week, also
  supplied by Greg. Used as-is by `html_render.py`.
- `_spotify.json` — **not** a real `spotify_lookup.py` run. It was hand-built
  by extracting every `open.spotify.com` link that actually appears in
  `2026-06-22.html` (9 links across 8 Top 3 picks — see the multi-artist gap
  below; an earlier version of this note said "8 links across 8 picks,"
  which undercounted) and encoding them in `spotify_lookup.py`'s output
  schema, so `html_render.py` could be tested against ground truth without
  live Spotify credentials. If `spotify_lookup.py` is ever re-run for real
  against this week, its output may differ slightly (Spotify search results
  can change over time) — that's expected and fine; this file exists purely
  to pin the *rendering* logic to a known-correct input, not to assert what
  a live lookup would return today.

## Known, deliberate divergences

`html_render.py`'s rendered output for this week does **not** byte-match
`2026-06-22.html`. See the module docstring in `scripts/html_render.py` for
the full rationale; in short: the real v1 output contains ad hoc LLM
editorial judgment (inconsistent category ordering, venue/cost/title/note
shortening, a synthesized "All Week" table) that a deterministic script
can't and shouldn't try to reproduce. Category grouping, chronological sort
(within its own stable tie-break, not v1's — see the html_render.py
docstring), Spotify link placement, sold-out handling, the "multiple
showtimes" time suffix, and honorable mentions were all validated to match.

## Known, unfixed gap: only one Spotify link per pick

`_spotify.json`'s schema is one `matched_text`/`spotify_url` per pick
*title*, so a pick naming two Spotify-matchable acts can only ever get one
linked. `2026-06-22.html`'s Sunday Human League pick names both "The Human
League" and "Soft Cell"; v1 linked both (9 links total across 8 Top 3
picks), v2 links only one (8). This is a real, acknowledged capability gap
versus `events-report-format/SKILL.md:128` ("for any music act... embed the
link"), not a bug — fixing it means changing `_spotify.json`'s schema,
`spotify_lookup.py`'s return shape, and `build_pick_name_html` together, and
is deliberately out of scope for the Presentation-completion chunk that
added this note.
