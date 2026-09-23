# Manual setup

Everything in this repo that a human has to do by hand: vendor accounts, OAuth consent,
where each secret lives, and how to rotate them later. Code and CI cover everything else.
This is a checklist, not a design doc — for *why* things are shaped this way, see
`docs/V2_IMPLEMENTATION_PLAN.md` (particularly gaps G3, G5, G8) and `CLAUDE.md`.

## Secrets and variables at a glance

| Name | Where | Used by | Get it from |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Actions secret, local `.env` | `collection.yml` (gcal venue sources), `presentation.yml` (`calendar_create.py`) | Google Cloud Console OAuth client — [Google Cloud / Calendar](#1-google-cloud--calendar) |
| `GOOGLE_CLIENT_SECRET` | Actions secret, local `.env` | same as above | same |
| `GOOGLE_REFRESH_TOKEN` | Actions secret, local `.env` | same as above | `scripts/oauth_bootstrap.py` |
| `SPOTIFY_CLIENT_ID` | Actions secret, local `.env` | `presentation.yml` (`spotify_lookup.py`, `spotify_playlist.py`) — **required**, job fails without it | Spotify app dashboard — [Spotify](#2-spotify) |
| `SPOTIFY_CLIENT_SECRET` | Actions secret, local `.env` | same as above — **required** | same |
| `SPOTIFY_REFRESH_TOKEN` | Actions secret, local `.env` | `spotify_playlist.py` only — **optional**, missing it just skips the playlist step (exit 0) | `scripts/spotify_oauth_bootstrap.py` |
| `SPOTIFY_REDIRECT_URI` | Actions secret, local `.env` | same as above — **optional** | must byte-match what's registered on the Spotify app |
| `SELECTION_ROUTINE_ID` | Actions **variable** (not secret) | `collection.yml`'s "Trigger Selection routine" step | the Selection Routine's API trigger — [Selection Routine](#4-selection-routine-claudeaicoderoutines) |
| `SELECTION_ROUTINE_TOKEN` | Actions secret | same step | same |
| `PICKS_LOG_PATH` | local `.env` only, optional | `csv_log.py` (currently inert, see below) | n/a — defaults to `data/event-picks-log.csv` |
| `HTTP_PROXY` / `HTTPS_PROXY` | set automatically | `fetch_page_text.py` | nothing to configure — set by the runner/Routine environment |

Nothing here should ever be committed. `.env` is gitignored; `credentials.json` (Google's
downloaded OAuth client) is gitignored too and is only ever needed transiently, local-only.

## 1. Google Cloud / Calendar

- [ ] In [Google Cloud Console](https://console.cloud.google.com), create (or reuse) a
      project and enable the **Google Calendar API**.
- [ ] Configure the OAuth consent screen, then **push it to Production** (not Testing).
      A consent screen left in Testing expires refresh tokens after 7 days — the pipeline
      would die silently the second week. No verification is needed for personal-scope use.
- [ ] Under APIs & Services → Credentials, create an **OAuth 2.0 Client ID**, type
      **Desktop app**. Download the JSON and save it as `credentials.json` in the repo
      root (already gitignored — never commit it).
- [ ] Run `python scripts/oauth_bootstrap.py`. A browser opens; log in and approve
      Calendar access (scope is `common.CALENDAR_SCOPES`, Calendar-only — no Drive, no
      Gmail). It prints a refresh token.
- [ ] Copy that refresh token into `GOOGLE_REFRESH_TOKEN`, and `GOOGLE_CLIENT_ID` /
      `GOOGLE_CLIENT_SECRET` from the same `credentials.json`, into **both**: your local
      `.env` and the repo's GitHub Actions secrets (Settings → Secrets and variables →
      Actions).
- [ ] Delete `credentials.json` once done — it doesn't need to run again unless the
      refresh token is revoked.
- [ ] In Google Calendar, create a calendar named **exactly** `Curated Events`.
      `calendar_create.py` (via `common.get_calendar_id()`) looks it up by that name and
      raises if it isn't found — nothing creates it for you.

Note: the three venue calendars Collection reads from (`collect_source.py`'s `gcal`
source) are third-party public calendars addressed by ID, not "Curated Events" — there's
nothing to create for those; they already exist.

## 2. Spotify

- [ ] At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard),
      create an app. Its Client ID and Client Secret are `SPOTIFY_CLIENT_ID` /
      `SPOTIFY_CLIENT_SECRET` — one app, shared by both Spotify scripts.
- [ ] Under the app's Settings, add the redirect URI `http://127.0.0.1:8888/callback`.
      Whatever you register must byte-match `SPOTIFY_REDIRECT_URI` everywhere it's set —
      Spotify may reject a bare `localhost` host in favor of the explicit `127.0.0.1`
      loopback.
- [ ] Export `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` locally (or put them in `.env`
      and `set -a; . ./.env; set +a`), then run
      `python scripts/spotify_oauth_bootstrap.py`. A browser opens; log in and approve
      playlist access (scope: `playlist-modify-public playlist-read-private`).
- [ ] Copy the printed refresh token into `SPOTIFY_REFRESH_TOKEN`, and set
      `SPOTIFY_REDIRECT_URI` — both in local `.env` and as GitHub Actions secrets.
      This token doesn't expire on its own; it only needs re-running if access is
      revoked or the scope changes.

`SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` alone are enough for `spotify_lookup.py`
(Client Credentials, app-only search). The refresh token and redirect URI are only for
`spotify_playlist.py`, which needs real user authorization to create/modify a playlist.

## 3. GitHub repository settings

- [ ] Pages: Settings → Pages → serve from `main` / `docs/`. The repo is public (an
      accepted tradeoff — see `V2_IMPLEMENTATION_PLAN.md` G8 — since the picks log and
      the `personal-interests` / `event-selection-philosophy` skills become
      world-readable).
- [ ] Actions: confirm no branch protection rule on `main` blocks pushes from
      `github-actions[bot]` — both workflows declare `permissions: contents: write` and
      push directly to `main`.
- [ ] Add every secret/variable in the table above under Settings → Secrets and
      variables → Actions (`SELECTION_ROUTINE_ID` goes under the **Variables** tab, not
      Secrets).
- [ ] Watch the repository (or otherwise make sure Actions failure emails reach you).
      That's the only failure alert this pipeline has (no custom notify script — a
      failed `presentation.yml` run is the only signal for a silent Sunday on that side).

## 4. Selection Routine (claude.ai/code/routines)

Selection is the one stage still running as a Claude Code Routine rather than a script.

- [ ] Create/confirm a Routine attached to this repo, running `claude-sonnet-5`, whose
      task is `.claude/skills/philly-events-selection/SKILL.md` (it in turn reads
      `personal-interests` and `event-selection-philosophy`).
- [ ] Give it a fallback cron roughly 30 minutes after Collection's own
      (`0 6 * * 0` UTC), e.g. `30 6 * * 0` UTC — this is the safety net for when the API
      trigger below doesn't fire.
- [ ] Add an **API trigger**: Edit routine → Select a trigger → API. Copy the resulting
      routine ID into the `SELECTION_ROUTINE_ID` repo **variable** and its token into the
      `SELECTION_ROUTINE_TOKEN` repo **secret**. `collection.yml`'s trigger step works
      with no further code change once these exist. Note `/fire` ships under an
      experimental beta header — request/response shape may change.
- [ ] Housekeeping: make sure no old/decommissioned Collection Routine or spike Routine
      is still enabled. A stale, still-firing Collection Routine caused a real incident
      (2026-08-02, a mistargeted push to `data/2026-08-04/`) — delete anything not the
      current Selection Routine at claude.ai/code/routines.

## 5. Local development

- [ ] Copy `.env.example` to `.env` and fill in the values above; load it with
      `set -a; . ./.env; set +a` before running scripts locally.
- [ ] Set up a Python venv: `scripts/requirements.txt` (+ `-collection.txt` for anything
      touching Playwright/browser-fetch, `-dev.txt` for ruff/mypy/pytest). See
      `CLAUDE.md`'s Commands section for the exact invocations.
- [ ] For the TypeScript port (`src/`, not yet wired into any workflow): `npm install`,
      then `npm test` / `npm run lint` / `npm run typecheck`.

## 6. Maintenance / rotation runbook

- **Google refresh token revoked or expired** (e.g. consent screen was left in Testing,
  or access was manually revoked): re-run `scripts/oauth_bootstrap.py` and update
  `GOOGLE_REFRESH_TOKEN` in both `.env` and the Actions secret.
- **Spotify access revoked or scope changed**: re-run
  `scripts/spotify_oauth_bootstrap.py` and update `SPOTIFY_REFRESH_TOKEN` (and
  `SPOTIFY_REDIRECT_URI` if it changed) in both places.
- **Selection didn't fire on Sunday**: check the Routines dashboard
  (claude.ai/code/routines) for a failed run, then trigger it manually. This is also
  what to check first for any "silent Sunday" — Collection/Selection failures don't
  surface via email, only Presentation's do.
- **Re-running Presentation for a week that already started**: `calendar_create.py`'s
  `week_has_already_begun()` guard skips the Calendar write (report still renders and
  publishes). Pass `--force-calendar` to override it deliberately.
- **Re-collecting a specific week**: run `collection.yml` via `workflow_dispatch` with
  `week_start` set to that Monday (blank picks the next upcoming Monday).
