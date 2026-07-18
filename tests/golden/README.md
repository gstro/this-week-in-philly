# Golden test fixtures

`2026-06-22.html` is the real HTML report v1 produced for the week of
2026-06-22, supplied directly by Greg from his local archive. It's the
reference used to validate `scripts/html_render.py` against actual
production output (not just the `events-report-format/SKILL.md` spec).

The corresponding source data lives at `data/2026-06-22/`:
- `_selections.json` — the real Selection-stage output for that week, also
  supplied by Greg. Used as-is by `html_render.py`.
- `_spotify.json` — **not** a real `spotify_lookup.py` run. It was hand-built
  by extracting every `open.spotify.com` link that actually appears in
  `2026-06-22.html` (8 links across 8 Top 3 picks) and encoding them in
  `spotify_lookup.py`'s output schema, so `html_render.py` could be tested
  against ground truth without live Spotify credentials. If `spotify_lookup.py`
  is ever re-run for real against this week, its output may differ slightly
  (Spotify search results can change over time) — that's expected and fine;
  this file exists purely to pin the *rendering* logic to a known-correct
  input, not to assert what a live lookup would return today.

## Known, deliberate divergences

`html_render.py`'s rendered output for this week does **not** byte-match
`2026-06-22.html`. See the module docstring in `scripts/html_render.py` for
the full rationale; in short: the real v1 output contains ad hoc LLM
editorial judgment (inconsistent category ordering, venue/cost/title
shortening, a synthesized "All Week" table) that a deterministic script
can't and shouldn't try to reproduce. Every other structural element —
category grouping, chronological sort, Spotify link placement, sold-out
handling, the "multiple showtimes" time suffix, honorable mentions, the
sources footer — was validated to match exactly.
