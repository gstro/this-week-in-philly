# 2026-08-03 manual pipeline test — archived

This is the full real output of the first end-to-end run of the whole pipeline
(Collection → Selection → Presentation), for the week of 2026-08-03, from
2026-08-01/02:

- Collection: `workflow_dispatch` run [30723644441](https://github.com/gstro/this-week-in-philly/actions/runs/30723644441)
- Selection: manually fired via the Routine trigger (`trig_01Tnyo7Gw1HQevCeEPBHgB1S`)
- Presentation: auto-fired by Selection's push, run [30724556898](https://github.com/gstro/this-week-in-philly/actions/runs/30724556898)

Moved out of `data/2026-08-03/` (and `docs/weeks/`) specifically so the real
scheduled cron on 2026-08-02 — which targets this same week
(`common.target_week_monday()` from a Sunday run always lands on the very
next Monday) — runs the whole chain unattended from a clean slate instead of
Selection's own guard immediately no-opping against an already-existing
`_selections.json`. Kept here for comparison against that run: same real
week, ~1 day apart, one manually triggered and reviewed, one fully automated.

`2026-08-03-report.html` is the rendered report as it briefly appeared on
GitHub Pages. Everything else (`_manifest.json`, `_candidates.json`,
`_selections.json`, and the 23 raw source files) is exactly what was
committed to `data/2026-08-03/` at the time, unmodified.
