# TypeScript port: tiers and known reproduced bugs

Living notes for the Python → TypeScript rewrite (`scripts/` → `src/`). The
Python stays the production path until each tier is parity-verified and the
workflows are cut over. Ports follow `.claude/agents/ts-port-parity.md`.

## Tiers

The original migration plan (referenced by PR #36) was never committed; this
is the working definition from Tier B on.

| Tier | Scope | Status |
|---|---|---|
| A | Pure data transforms on committed files: `common`, `prepare_selection_input`, `merge_selections`, `check_selection`, `check_yield`, `html_render`, `csv_log`, `attendance_check` | Done (PRs #36–#75) |
| B | Collection — reads the web, writes only inside the repo: `event_parsers/*` (pure; fixture-tested), then `fetch_raw`, `proxy_session`, `fetch_page_text` (Playwright), `collect_source`, `collect_week` | In progress |
| C | Presentation's external steps: `spotify_lookup`, `spotify_playlist`, `calendar_create`, `oauth_bootstrap`, `spotify_oauth_bootstrap`. Mutating steps are tested in `--dry-run` only | Not started |
| D | Cut `collection.yml` / `presentation.yml` / `collection-check.yml` / `runner.sh` over to `src/`, then delete `scripts/` and the Python toolchain | Not started |

`token_report.py` is a local dev tool (Selection token accounting from session
transcripts), not a pipeline stage; port it whenever convenient or drop it.

## Known bugs reproduced by the port

Ports reproduce Python behaviour byte-for-byte, bugs included, so parity can
be proven. These are the bugs that were found and deliberately kept. Fix them
in a dedicated PR (Python and TS together while both exist, or TS-only with a
"Divergences" entry, as PR #73 did for `htmlRender`).

### `html_render` — fixed in TS by #73, still present in Python

- Non-canonical categories are silently dropped from the day blocks.
- Top 3 times never get the `+` (multiple showtimes) suffix.
- An empty `matched_text` produces an empty `<a>`.
- `SOURCE_SPLIT_RE` splits on commas inside Meetup group names.
- `date.fromisoformat` accepts `20260622` / `2026-W26-1`, which can produce bogus canonical URLs and index rows.
- `check_yield_floor` raises `TypeError` on `"events": null`.
- `tests/test_html_render.py:124-126` wrongly says autoescape leaves `'` as-is (it writes `&#39;`).

### `csv_log` — present in both (shelved; not in `runner.sh`)

- `open()` has no `encoding=`, so the log's encoding follows the machine's locale (TS always uses UTF-8).
- A zero-byte existing log never gets a header; a log without a trailing newline gets the first new row glued onto its last line.
- Idempotency only works across runs: a duplicate `(week_of, title)` within one week is written twice.
- Editing a title breaks the `(week_of, title)` key, so the event is logged again.
- A Spotify entry without `spotify_url` raises `KeyError`; `honorable_mentions: null` raises `TypeError`.

### `attendance_check` — present in both (shelved; not in `runner.sh`)

- **The log is emptied before rows are validated.** `open(log_path, "w")` truncates first, then `DictWriter` raises on a row longer than the header or a header with no `attended` column, leaving the log cut short. Write to a temp file and rename. **Fix before the attendance loop is re-enabled.**
- `--dry-run` still calls Google Calendar (read-only); it only skips the CSV write.
- A blank first line in the log gives `KeyError 'city'` instead of a clear error.

### Open gaps (not port bugs)

- `spotify_lookup`'s follower-count tie-break (#71) is inert: live artist search results carry no `followers`, so name clashes still follow Spotify's drifting order.
