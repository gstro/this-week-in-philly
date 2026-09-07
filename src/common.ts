/**
 * Shared helpers for the This Week in Philly v2 script suite -- a port of
 * scripts/common.py. Google auth is Calendar-only and reconstructed
 * entirely from env vars (G3): Routines and GitHub Actions runners have no
 * durable home directory, so credentials are never written to disk. All
 * paths are repo-relative; there is no Drive or Gmail access in v2.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calendar_v3, google } from "googleapis";

// dist/common.js sits at <repo>/dist/common.js, the same one-level depth as
// scripts/common.py under <repo>/scripts/common.py.
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = join(REPO_ROOT, "data");

export const CALENDAR_NAME = "Curated Events";
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];
export const CALENDAR_TIMEZONE = "America/New_York";

// Two scopes, and both are load-bearing:
//
// playlist-modify-public -- the playlists are public, because the report is
//   served on GitHub Pages and a private playlist link would be dead for every
//   reader but Greg. That's what makes this the right scope rather than
//   playlist-modify-private.
// playlist-read-private -- required by GET /v1/me/playlists, which backs
//   spotify_playlist.ts's find-by-name fallback. modify-public does NOT cover
//   reading the user's playlist list, and without this the fallback fails,
//   gets swallowed, and the step silently never builds a playlist.
//
// Scope is fixed at consent time: changing this string means re-running
// spotify_oauth_bootstrap and re-issuing SPOTIFY_REFRESH_TOKEN.
export const SPOTIFY_PLAYLIST_SCOPE = "playlist-modify-public playlist-read-private";

// Distinct dates a same-(title, venue) series must hit inside the target week
// before prepare_selection_input.ts collapses it to one candidate carrying
// `occurrences`/`recurrence_count`, and before html_render.ts routes it into
// the "All Week / Recurring" table instead of a day's category block. Shared
// here rather than duplicated because the collapser and the renderer must
// agree on it -- the same reason CATEGORY_ORDER lives here.
export const RECURRING_THRESHOLD = 3;

// The nine canonical category strings (emoji included, exact match), in
// report display order. See docs/v1/Skills/events-report-format/SKILL.md.
// A literal "&", never HTML-escaped -- exact-match required in
// merge_selections' category validation, html_render's category grouping,
// and csv_log's CSV-slug mapping.
export const CATEGORY_ORDER = [
  "🎵 Music & Concerts",
  "🎬 Film & Cinema",
  "📚 Literary",
  "🤝 Community & Politics",
  "🎨 Arts & Workshops",
  "💻 Tech & Maker",
  "🌿 Markets & Outdoors",
  "👻 Horror & Occult",
  "🎪 Festivals & Major Events",
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

// Maps the canonical emoji category strings to the short lowercase slugs
// used in the picks-log CSV's category column. Validated against the real
// 2026-06-22 archived week's rows in docs/v1/Data/event-picks-log.csv
// (all nine slugs confirmed; "outdoors" and "horror" only had precedent in
// other weeks in that file, not 2026-06-22 itself, since those categories
// didn't appear in that week's Top 3/honorable-mention picks).
export const CATEGORY_TO_CSV_SLUG: Record<Category, string> = {
  "🎵 Music & Concerts": "music",
  "🎬 Film & Cinema": "film",
  "📚 Literary": "literary",
  "🤝 Community & Politics": "community",
  "🎨 Arts & Workshops": "arts",
  "💻 Tech & Maker": "tech",
  "🌿 Markets & Outdoors": "outdoors",
  "👻 Horror & Occult": "horror",
  "🎪 Festivals & Major Events": "festival",
};

// Picks-log columns per CLAUDE.md's "Key contracts" section -- change with
// care, this is the interface csv_log.ts and attendance_check.ts share.
export const PICKS_LOG_COLUMNS = [
  "city",
  "week_of",
  "day",
  "date",
  "title",
  "venue",
  "category",
  "source",
  "rank",
  "price_tier",
  "spotify_link",
  "tags",
  "attended",
] as const;

// Cost values treated as free beyond the literal "free" (case-insensitive).
// Validated against tests/golden/2026-06-22.html and the real picks-log CSV;
// extend if a future week surfaces another synonym, but don't guess ahead
// of evidence.
export const FREE_COST_SYNONYMS = new Set(["free", "no cover"]);

/**
 * True if `text` is a literal *(...)* unconfirmed-value wrapper, e.g.
 * "*(confirm details)*" -- Selection's convention for "don't know yet".
 */
export function isPlaceholderCost(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return trimmed.startsWith("*(") && trimmed.endsWith(")*");
}

/**
 * Strips a literal *(...)* placeholder wrapper (e.g. "*(confirm details)*"
 * -> "confirm details"). Used for both cost and time -- both fields use
 * this convention to flag uncertain/unconfirmed values.
 */
export function stripPlaceholderWrapper(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  if (isPlaceholderCost(trimmed)) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

export function isFreeCost(cost: string | null | undefined): boolean {
  return FREE_COST_SYNONYMS.has(stripPlaceholderWrapper(cost).toLowerCase());
}

/** Repo-relative by default; overridable via the PICKS_LOG_PATH env var. */
export function picksLogPath(): string {
  const override = process.env["PICKS_LOG_PATH"];
  if (override) {
    return isAbsolute(override) ? override : join(REPO_ROOT, override);
  }
  return join(DATA_DIR, "event-picks-log.csv");
}

function toIsoDate(d: Date): string {
  const year = d.getFullYear().toString().padStart(4, "0");
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromIsoDate(iso: string): Date {
  const parts = iso.split("-").map(Number);
  const [year, month, day] = [parts[0]!, parts[1]!, parts[2]!];
  return new Date(year, month - 1, day);
}

/**
 * The Monday immediately following `today` (strictly after, never today).
 *
 * Per CLAUDE.md's week window convention: every stage covers the Monday
 * immediately following the run date through the Sunday after, computed at
 * runtime and never hardcoded.
 *
 * `today` is an injectable "YYYY-MM-DD" local-calendar-date string (never a
 * timestamp) so tests can pin the date without mocking the system clock --
 * mirrors common.py's `today: date | None` parameter shape. Defaults to the
 * system's local date (matching Python's `date.today()`).
 */
export function targetWeekMonday(today?: string): string {
  const base = today !== undefined ? fromIsoDate(today) : new Date();
  const weekday = base.getDay(); // Sunday = 0 ... Saturday = 6
  const mondayIndex = (weekday + 6) % 7; // Monday = 0 ... Sunday = 6
  let daysAhead = (7 - mondayIndex) % 7;
  if (daysAhead === 0) daysAhead = 7;
  const result = new Date(base);
  result.setDate(result.getDate() + daysAhead);
  return toIsoDate(result);
}

/** The 7 dates (Monday through Sunday) for the week starting `monday`. */
export function weekDates(monday: string): string[] {
  const start = fromIsoDate(monday);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return toIsoDate(d);
  });
}

export function weekDirPath(monday: string): string {
  return join(DATA_DIR, monday);
}

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSelections(weekDir: string): unknown {
  const path = join(weekDir, "_selections.json");
  if (!existsSync(path)) {
    throw new Error(
      `Selections have not run for this week. Run the report selection task first. Expected: ${path}`,
    );
  }
  return loadJson(path);
}

/** Returns {} if _spotify.json doesn't exist yet (spotify_lookup hasn't run). */
export function loadSpotify(weekDir: string): unknown {
  const path = join(weekDir, "_spotify.json");
  if (!existsSync(path)) return {};
  return loadJson(path);
}

/**
 * Returns {} if _playlist.json doesn't exist yet (spotify_playlist hasn't
 * run, or ran without credentials). The report renders fine without it --
 * the playlist link is optional by design.
 */
export function loadPlaylist(weekDir: string): unknown {
  const path = join(weekDir, "_playlist.json");
  if (!existsSync(path)) return {};
  return loadJson(path);
}

export interface SpotifyUserClient {
  accessToken: string;
}

/**
 * A *user-authorized* Spotify client, rebuilt from env vars each run (G3).
 *
 * Distinct from spotify_lookup.ts's Client Credentials flow on purpose.
 * Client Credentials is app-only: it has no user context and therefore
 * cannot create or modify playlists. Only the Authorization Code flow can,
 * which needs a user refresh token obtained once, by hand, via
 * spotify_oauth_bootstrap. spotify_lookup.ts deliberately stays on the
 * app-only flow -- it only searches, and having no refresh token to expire
 * is a feature there.
 *
 * Required: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN,
 * SPOTIFY_REDIRECT_URI. The redirect URI is never actually visited here, but
 * Spotify's token endpoint requires it to byte-match one registered on the
 * Spotify app, since it's sent with the refresh request.
 *
 * No token cache file is written anywhere (the Python original's
 * MemoryCacheHandler requirement) -- this always performs a fresh refresh
 * request and returns the access token in memory, never touching disk.
 * Actions runners and Routines have no durable home directory (G3), so
 * anything that depends on a cache file on disk is broken by construction.
 */
export async function getSpotifyUserClient(): Promise<SpotifyUserClient> {
  const clientId = process.env["SPOTIFY_CLIENT_ID"];
  const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"];
  const refreshToken = process.env["SPOTIFY_REFRESH_TOKEN"];
  const redirectUri = process.env["SPOTIFY_REDIRECT_URI"];
  const missing = (
    [
      ["SPOTIFY_CLIENT_ID", clientId],
      ["SPOTIFY_CLIENT_SECRET", clientSecret],
      ["SPOTIFY_REFRESH_TOKEN", refreshToken],
      ["SPOTIFY_REDIRECT_URI", redirectUri],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s) for Spotify user auth: ${missing.join(", ")}. ` +
        "Run spotify_oauth_bootstrap once to get SPOTIFY_REFRESH_TOKEN.",
    );
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken!,
      redirect_uri: redirectUri!,
    }),
  });
  if (!response.ok) {
    throw new Error(`Spotify token refresh failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string };
  return { accessToken: body.access_token };
}

export interface CalendarCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
}

/**
 * Reconstructs Google OAuth2 credentials from env vars (G3).
 *
 * Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
 * Throws with a clear message if any are missing, rather than letting the
 * underlying library fail cryptically.
 */
export function getCalendarCredentials(): CalendarCredentials {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  const refreshToken = process.env["GOOGLE_REFRESH_TOKEN"];
  const missing = (
    [
      ["GOOGLE_CLIENT_ID", clientId],
      ["GOOGLE_CLIENT_SECRET", clientSecret],
      ["GOOGLE_REFRESH_TOKEN", refreshToken],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s) for Google auth: ${missing.join(", ")}`);
  }
  return { clientId: clientId!, clientSecret: clientSecret!, refreshToken: refreshToken!, scopes: CALENDAR_SCOPES };
}

export function getCalendarService(): calendar_v3.Calendar {
  const creds = getCalendarCredentials();
  const auth = new google.auth.OAuth2({ clientId: creds.clientId, clientSecret: creds.clientSecret });
  auth.setCredentials({ refresh_token: creds.refreshToken });
  return google.calendar({ version: "v3", auth });
}

/**
 * Finds the "Curated Events" calendar by name. Throws if not found --
 * matches v1's behavior of stopping and telling Greg to create it first.
 */
export async function getCalendarId(service: calendar_v3.Calendar): Promise<string> {
  let pageToken: string | undefined;
  do {
    const result = await service.calendarList.list(pageToken ? { pageToken } : {});
    for (const entry of result.data.items ?? []) {
      if (entry.summary === CALENDAR_NAME && entry.id) {
        return entry.id;
      }
    }
    pageToken = result.data.nextPageToken ?? undefined;
  } while (pageToken);
  throw new Error(`Calendar "${CALENDAR_NAME}" not found. Create it before continuing.`);
}
