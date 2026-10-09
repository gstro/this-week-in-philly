# TypeScript port: tiers and known reproduced bugs

Living notes for the Python → TypeScript rewrite (`scripts/` → `src/`). The
Python stays the production path until each tier is parity-verified and the
workflows are cut over. Ports follow `.claude/agents/ts-port-parity.md`.

**Approach from Tier B on: idiomatic over faithful.** Tier A ports reproduced
the Python byte-for-byte, bugs and all, which in places meant emulating Python
itself (`htmlRender`'s Nunjucks escaping hook, `csvLog`'s copies of the `csv`
module and `difflib`). From Tier B on, ports use ordinary TypeScript libraries
and idioms, fix known Python bugs rather than copy them, and are checked for
"same results" on real inputs (e.g. `tests/fixtures/parse_events/real/`), with
every intentional difference listed in the module's "Divergences from the
Python". The Tier A emulation is being removed module by module: `htmlRender`
is done (plain Nunjucks autoescape, `Date`/`Intl`; checked as "same DOM" as the
Python on every committed week), and so are `csvLog`/`attendanceCheck`
(`csv-parse`/`csv-stringify`, a word-set similarity instead of `difflib`;
checked as the same parsed rows as the Python).

## Tiers

The original migration plan (referenced by PR #36) was never committed; this
is the working definition from Tier B on.

| Tier | Scope | Status |
|---|---|---|
| A | Pure data transforms on committed files: `common`, `prepare_selection_input`, `merge_selections`, `check_selection`, `check_yield`, `html_render`, `csv_log`, `attendance_check` | Done (PRs #36–#75) |
| B | Collection — reads the web, writes only inside the repo: `event_parsers/*` (pure; fixture-tested), then `fetch_raw`, `proxy_session`, `fetch_page_text` (Playwright), `collect_source`, `collect_week` | In progress: `event_parsers` → `src/eventParsers/` done |
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

### `csv_log` — fixed in TS (except where noted), still present in Python (shelved; not in `runner.sh`)

- `open()` has no `encoding=`, so the log's encoding follows the machine's locale (TS always uses UTF-8).
- A zero-byte existing log never gets a header; a log without a trailing newline gets the first new row glued onto its last line.
- Idempotency only works across runs: a duplicate `(week_of, title)` within one week is written twice.
- Editing a title breaks the `(week_of, title)` key, so the event is logged again. **Still present in TS** (it's inherent to the key).
- A Spotify entry without `spotify_url` raises `KeyError`; `honorable_mentions: null` raises `TypeError`.

### `attendance_check` — fixed in TS (except where noted), still present in Python (shelved; not in `runner.sh`)

- **The log is emptied before rows are validated.** `open(log_path, "w")` truncates first, then `DictWriter` raises on a row longer than the header or a header with no `attended` column, leaving the log cut short. The TS validates the whole log first and writes via temp file + rename. **The Python must be fixed (or replaced by the TS) before the attendance loop is re-enabled.**
- `--dry-run` still calls Google Calendar (read-only); it only skips the CSV write. **Kept in TS** (reading is harmless).
- A blank first line in the log gives `KeyError 'city'` instead of a clear error.
- **Data quirk, not a bug:** the v1 picks log uses each event's date as `week_of` for 2026-06-08 through 06-21, so attendance can't match those rows by week in either implementation. Matters only if the loop is run over that history.

### `event_parsers` — fixed in TS, still present in Python (production: Collection)

These parsers run every Sunday, so unlike the shelved modules above they
affect the published report today. Each fix is listed in the TS parser's
"Divergences from the Python".

- **Broken links (confirmed live):** `philly_ask_a_punk` builds `https://philly.askapunk.net/<slug>`, which returns 404; the real page is `/event/<slug>` (checked 2026-10-07). Every Ask A Punk link in published reports is dead.
- **Silent wrong data:**
  - `r5_productions`: `find_previous(id="eventDate")` gives a listing with no date of its own the previous event's date.
  - `do215`: an explicit `null` title or permalink is written as `"None"` / `"https://do215.comNone"`.
  - `philly_ask_a_punk`: a string `tags` is joined character by character; a multi-day event that started before the week keeps its pre-week start date.
  - `lightbox`: a JSON-LD `PostalAddress` object in `location.address` lands in the venue as a Python dict repr; `"@type": ["Event"]` is skipped.
  - `_ical`: only a space continues a folded line (RFC 5545 also allows a tab); an escaped backslash followed by `n` becomes backslash + newline; `\N` is never unescaped.
- **One bad record fails the whole source** (uncaught exception): an impossible time in `luma`, `meetup`, `cinespeak` or `philadelphia_film_society` ("7:75 pm"); wrong JSON types in `philly_ask_a_punk`, `do215`, `lightbox`, `gcal`, `wxpn`, `philadelphia_film_society`. The TS skips that record with a stderr warning instead, but throws `ParseError` if *every* record is malformed, so a format change still marks the source failed rather than an empty "ok". (`the_rotunda`'s `isdigit()`/`int()` mismatch on "²" is avoided in TS by matching only ASCII digits; such a cell is ignored.)
- **TS follow-up for the `collect_week` port:** a *partial* malformed-record skip is only visible as stderr warnings. Surface a skip count in the manifest `note`, the way `partial_failure_note` does for failed requests.
- **Unpinned Python patch level:** CPython's `html.parser` changed across 2025's 3.12.x security releases, and `.python-version` / `collection-check.yml` pin only `3.12`; `beautifulsoup4` is unpinned too. Collection's output can shift with the runner image.
- **Unverified:** `luma` treats a start time without a trailing `Z` as UTC (kept as-is in TS).

### Open gaps (not port bugs)

- `spotify_lookup`'s follower-count tie-break (#71) is inert: live artist search results carry no `followers`, so name clashes still follow Spotify's drifting order.
