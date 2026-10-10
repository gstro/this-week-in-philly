/**
 * Builds a public Spotify playlist from every music act in a week's report.
 * Rewrite of scripts/spotify_playlist.py.
 *
 * Reads data/YYYY-MM-DD/_spotify.json (spotifyLookup's output) and
 * _selections.json, takes a handful of recent tracks for every matched
 * artist, and replaces the contents of a per-week playlist named
 * "YYYY-MM-DD: This Week in Philly" -- date first, so a truncated title in
 * Spotify's sidebar still sorts and reads chronologically. The playlist's id
 * and URL go to data/YYYY-MM-DD/_playlist.json, which htmlRender reads for the
 * report header link.
 *
 * Track source: an artist's most recent album or single tracks, NOT their
 * "top tracks". GET /v1/artists/{id}/top-tracks returned 403 for every artist
 * tried (a global megastar included, under both auth flows) and Spotify's
 * reference now reads "Deprecated"; search's `track` results lost `popularity`
 * in the same pass, ruling out search + sort by popularity. The artist-albums
 * and album-tracks endpoints were verified against this project's real
 * 2026-09-07 matched artists (small DIY acts, not a celebrity). If they go
 * too, the fallback has the same shape: anything returning track URIs for a
 * known artist id.
 *
 * Auth is NOT spotifyLookup's. That one is Client Credentials (app-only,
 * cannot touch playlists); this uses the user-authorized client
 * (common.getSpotifyUserClient, via lib/spotifyHttp.spotifyUserApi). See
 * spotify_oauth_bootstrap for the one-time consent step.
 *
 * Idempotency: presentation.yml fires on any push to a
 * _selection_annotations.json, backfills of historical weeks included -- the
 * shape that caused the 2026-08-23 calendar incident. So a re-run must
 * converge, not accumulate: the playlist is found by stored id, then by exact
 * name, created only if neither hits, and its tracks are replaced, never
 * appended. Unlike calendar_create there is deliberately no past-week guard:
 * that guard protects the attendance signal, which a playlist doesn't carry,
 * so it would only block legitimate backfill re-renders.
 *
 * Scope: every music event in the report (common.musicEvents) and every
 * matched act on each bill (_spotify.json's `artists`; older files without it
 * contribute their one top-level match). --max-artists caps the total, Top 3
 * acts first, so it can only drop the long tail (insurance against a malformed
 * week like 2026-08-03, whose events[] holds 172 music events).
 *
 * Every Spotify-facing failure is non-fatal on purpose: an expired refresh
 * token, a dead endpoint, a rate-limit ban or an outage must not stop the
 * report from rendering. The step says why on stderr, exits 0, and htmlRender
 * treats a missing _playlist.json as "no link".
 *
 * Divergences from the Python:
 * - A week spanning two months gets a correct description ("September
 *   28-October 4, 2026"); the Python wrote "September 28-4, 2026" (and, over
 *   New Year, one year for both ends). Re-running a cross-month week rewrites
 *   its playlist description.
 * - Calls go through lib/spotifyHttp: network errors, 429 and 5xx are retried,
 *   each request times out after 10s, and a Retry-After over 60s (a ban) ends
 *   the step at once instead of sleeping through it as spotipy does.
 * - A POST (create, append) is never retried after a timeout or 5xx -- the
 *   server may have acted, and a retry would duplicate the playlist or a
 *   100-track chunk (spotipy retries 5xx on POST). A failed run just skips;
 *   the next run finds the playlist by name. Only a 429 is retried.
 * - The token refresh has a 10s timeout, so a hung accounts.spotify.com can't
 *   hang the "non-fatal" step.
 * - Overflow tracks are added with the documented `{uris}` body; spotipy posts
 *   a bare array. Unverified against the live API (a run needs more than 100
 *   tracks, and live writes happen only at the Tier D cutover).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { type MusicSelections, loadPlaylist, loadSelections, loadSpotify, musicEvents, weekDates } from "./common.js";
import { writeJson } from "./lib/json.js";
import { type SpotifyUserApi, spotifyUserApi } from "./lib/spotifyHttp.js";

export const REPORT_BASE_URL = "https://gstro.github.io/this-week-in-philly/weeks";

// Spotify's playlist-items endpoints cap each call at 100 URIs.
const MAX_ITEMS_PER_CALL = 100;

// artist-albums and album-tracks are market-scoped; without one, results can
// be incomplete or empty for an artist not licensed everywhere.
const MARKET = "US";

// How many of an artist's most recent albums/singles to consider before
// giving up on finding enough tracks. Plenty for the default of 3 tracks per
// artist: most fill that from their single latest release.
const ALBUMS_TO_CONSIDER = 10;

export const DEFAULT_MAX_ARTISTS = 50;
export const DEFAULT_TRACKS_PER_ARTIST = 3;

/** Date first, deliberately: Spotify truncates playlist titles in the sidebar and shared cards. */
export function playlistName(monday: string): string {
  return `${monday}: This Week in Philly`;
}

const formatDay = (iso: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${iso}T00:00:00Z`));

export function playlistDescription(monday: string): string {
  const sunday = weekDates(monday).at(-1)!;
  const start = formatDay(monday, { month: "long", day: "numeric" });
  const sameMonth = monday.slice(0, 7) === sunday.slice(0, 7);
  const sameYear = monday.slice(0, 4) === sunday.slice(0, 4);
  const range = sameMonth
    ? `${start}-${formatDay(sunday, { day: "numeric" })}, ${sunday.slice(0, 4)}`
    : sameYear
      ? `${start}-${formatDay(sunday, { month: "long", day: "numeric" })}, ${sunday.slice(0, 4)}`
      : `${start}, ${monday.slice(0, 4)}-${formatDay(sunday, { month: "long", day: "numeric" })}, ${sunday.slice(0, 4)}`;
  return `Music from the acts in this week's report, ${range}. Top 3 picks first each day. ${REPORT_BASE_URL}/${monday}.html`;
}

/**
 * The id out of an open.spotify.com/artist/<id> URL. Parsing beats adding an
 * `artist_id` field to _spotify.json: the schema stays as spotifyLookup and
 * htmlRender know it, and every week already on disk works unchanged.
 */
export function artistIdFromUrl(url: string | undefined | null): string | null {
  let path: string;
  try {
    path = new URL(url ?? "").pathname;
  } catch {
    // Not an absolute URL; the Python's urlparse would still read a bare path.
    path = (url ?? "").split(/[?#]/)[0] ?? "";
  }
  const parts = path.split("/").filter(Boolean);
  const [kind, id] = parts.slice(-2);
  return parts.length >= 2 && kind === "artist" && id ? id : null;
}

/** What {@link matchedArtists} reads of one _spotify.json entry. */
export interface SpotifyEntryLike {
  spotify_url?: string;
  artists?: Array<{ spotify_url?: string }>;
}

/**
 * [artistId, isTop3] for every matched act in the week's music events, in
 * report order (day, then Top 3 / honorable mention / rest, then billing
 * order), deduped by artist.
 *
 * Iterating _selections.json rather than _spotify.json's keys is what makes
 * the playlist run chronologically through the week -- spotifyLookup writes
 * its output sorted by title, which would scramble it. An artist keeps its
 * first position but is marked Top 3 if *any* of its events was a Top 3 pick,
 * so a band that is a Monday also-ran and a Friday pick is still kept first
 * by {@link capArtists}.
 */
export function matchedArtists(selections: MusicSelections, spotify: Record<string, SpotifyEntryLike | null>): Array<[string, boolean]> {
  const top3ById = new Map<string, boolean>(); // insertion order = report order
  for (const [title, top3] of musicEvents(selections)) {
    const entry = spotify[title];
    if (!entry) continue;
    for (const artist of entry.artists?.length ? entry.artists : [entry]) {
      const id = artistIdFromUrl(artist.spotify_url);
      if (!id) continue;
      top3ById.set(id, (top3ById.get(id) ?? false) || top3);
    }
  }
  return [...top3ById];
}

/** At most `maxArtists`, Top 3 acts first, then the rest in report order -- returned in report order either way. */
export function capArtists(artists: Array<[string, boolean]>, maxArtists: number): Array<[string, boolean]> {
  const kept = artists.filter(([, top3]) => top3).slice(0, maxArtists);
  kept.push(...artists.filter(([, top3]) => !top3).slice(0, Math.max(0, maxArtists - kept.length)));
  const keep = new Set(kept.map(([id]) => id));
  return artists.filter(([id]) => keep.has(id));
}

/**
 * Up to `limit` track URIs from an artist's most recent albums/singles,
 * newest release first.
 *
 * include_groups=album,single excludes compilations and "appears on" credits
 * -- the latter would pull in tribute albums and festival samplers that don't
 * represent the artist's own work. The endpoint's result order isn't
 * documented as guaranteed, so release_date is re-sorted client-side; dates of
 * mixed precision (a bare year vs a full YYYY-MM-DD) can sort slightly out of
 * true order against each other, an accepted rough edge.
 *
 * An artist with no albums/singles yields [] -- a normal outcome (a run of
 * them is caught by the caller's zero-tracks guard), not an error. Genuine API
 * failures (auth, rate limit, a now-deprecated endpoint) are deliberately NOT
 * caught: they propagate and stop the run at once rather than repeating the
 * same failure for every remaining artist.
 */
export async function trackUrisForArtist(api: Pick<SpotifyUserApi, "get">, artistId: string, limit: number): Promise<string[]> {
  const albums = await api.get<{ items: Array<{ id: string; release_date?: string }> }>(`/artists/${encodeURIComponent(artistId)}/albums`, {
    include_groups: "album,single",
    country: MARKET,
    limit: String(ALBUMS_TO_CONSIDER),
  });
  // Descending and stable: equal dates keep Spotify's order, as Python's sorted(reverse=True) does.
  const ordered = [...albums.items].sort((a, b) => ((a.release_date ?? "") < (b.release_date ?? "") ? 1 : (a.release_date ?? "") > (b.release_date ?? "") ? -1 : 0));

  const uris: string[] = [];
  const seen = new Set<string>();
  for (const album of ordered) {
    if (uris.length >= limit) break;
    const tracks = await api.get<{ items: Array<{ uri: string }> }>(`/albums/${encodeURIComponent(album.id)}/tracks`, { market: MARKET, limit: String(limit) });
    for (const track of tracks.items) {
      if (!seen.has(track.uri)) {
        seen.add(track.uri);
        uris.push(track.uri);
      }
      if (uris.length >= limit) break;
    }
  }
  return uris;
}

/**
 * Track URIs for every matched artist, in order, concatenated. No per-artist
 * try/catch: an exception means the API call itself failed (not "this artist
 * has no tracks"), almost always something systemic that would recur for every
 * remaining artist. Stopping at the first turns N identical failures into one.
 */
export async function collectTrackUris(api: Pick<SpotifyUserApi, "get">, artistIds: string[], limit: number): Promise<string[]> {
  const uris: string[] = [];
  for (const id of artistIds) uris.push(...(await trackUrisForArtist(api, id, limit)));
  return uris;
}

interface PlaylistSummary {
  id: string;
  name?: string;
  owner?: { id?: string };
}

/**
 * The stored id first, then an exact name match among the user's own
 * playlists, then null.
 *
 * The name search is not redundant. _playlist.json is committed by
 * presentation.yml, but a run whose push fails -- or any run before that step
 * existed -- leaves a real playlist with no record of it. On the id path, a
 * playlist deleted by hand returns 404 and must fall through to creation.
 * (No `fields` filter on the GET: Spotify's filter syntax uses parentheses
 * (`owner(id)`), and a wrong one yields a response with no `owner`, which
 * would silently demote this path to the name scan on every run.)
 */
export async function findExistingPlaylist(
  api: Pick<SpotifyUserApi, "get">,
  userId: string,
  name: string,
  storedId?: string | null,
): Promise<string | null> {
  if (storedId) {
    try {
      const playlist = await api.get<PlaylistSummary>(`/playlists/${encodeURIComponent(storedId)}`);
      if (playlist.owner?.id === userId) return playlist.id;
    } catch (err) {
      console.log(`  Stored playlist ${storedId} unusable (${err instanceof Error ? err.message : String(err)}); searching by name.`);
    }
  }

  let page: { items?: PlaylistSummary[]; next?: string | null } | undefined = await api.get("/me/playlists", { limit: "50" });
  while (page) {
    for (const playlist of page.items ?? []) {
      if (playlist.name === name && playlist.owner?.id === userId) return playlist.id;
    }
    page = page.next ? await api.get(page.next) : undefined;
  }
  return null;
}

/**
 * Replace, never append -- a re-run must converge, not accumulate. The first
 * call replaces (which also clears the playlist when `uris` is empty); any
 * overflow past Spotify's 100-per-call cap is appended after it. A normal
 * week (20-40 artists x 3 tracks) routinely passes the cap.
 */
export async function setPlaylistTracks(api: Pick<SpotifyUserApi, "put" | "post">, playlistId: string, uris: string[]): Promise<void> {
  await api.put(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris: uris.slice(0, MAX_ITEMS_PER_CALL) });
  for (let start = MAX_ITEMS_PER_CALL; start < uris.length; start += MAX_ITEMS_PER_CALL) {
    await api.post(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris: uris.slice(start, start + MAX_ITEMS_PER_CALL) });
  }
}

export interface PlaylistResult {
  name: string;
  playlist_id: string;
  playlist_url: string;
  artist_count: number;
  track_count: number;
}

/**
 * Find-or-create the week's playlist and replace its contents with `uris`.
 * Separate from track resolution so --dry-run can run the (read-only, safe)
 * resolution without ever reaching these mutating calls.
 */
export async function syncPlaylist(api: SpotifyUserApi, monday: string, uris: string[], artistCount: number, storedId?: string | null): Promise<PlaylistResult> {
  const name = playlistName(monday);
  const description = playlistDescription(monday);

  const userId = (await api.get<{ id: string }>("/me")).id;
  let playlistId = await findExistingPlaylist(api, userId, name, storedId);
  if (playlistId) {
    await api.put(`/playlists/${encodeURIComponent(playlistId)}`, { name, description });
  } else {
    // POST /me/playlists, NOT POST /users/{user_id}/playlists: Spotify's
    // February 2026 Development Mode changes removed the latter, which 403s
    // with no detail regardless of scope, token freshness or dashboard
    // user-management state (all of which the error could easily have been).
    playlistId = (await api.post<{ id: string }>("/me/playlists", { name, public: true, collaborative: false, description })).id;
  }

  await setPlaylistTracks(api, playlistId, uris);

  return {
    name,
    playlist_id: playlistId,
    playlist_url: `https://open.spotify.com/playlist/${playlistId}`,
    artist_count: artistCount,
    track_count: uris.length,
  };
}

export interface RunOptions {
  weekDir: string;
  tracksPerArtist?: number;
  maxArtists?: number;
  dryRun?: boolean;
  /** Defaults to the user-authorized client built from env vars. */
  api?: SpotifyUserApi;
}

const skipped = (reason: unknown): void => {
  console.error(
    `spotify_playlist: SKIPPING playlist build -- ${reason instanceof Error ? reason.message : String(reason)}\n  The report will render without a playlist link.`,
  );
};

/** Builds (or, with dryRun, only resolves) the week's playlist. Always exits 0: see the module header. */
export async function buildPlaylist({ weekDir, tracksPerArtist = DEFAULT_TRACKS_PER_ARTIST, maxArtists = DEFAULT_MAX_ARTISTS, dryRun = false, api }: RunOptions): Promise<number> {
  const selections = loadSelections(weekDir) as MusicSelections & { days: Array<{ date: string }> };
  const spotify = loadSpotify(weekDir) as Record<string, SpotifyEntryLike | null>;
  const monday = selections.days[0]!.date;
  const artists = matchedArtists(selections, spotify);
  const capped = capArtists(artists, maxArtists);
  if (capped.length < artists.length) {
    console.log(`  Capped at ${String(capped.length)} of ${String(artists.length)} matched artists (--max-artists).`);
  }
  const artistIds = capped.map(([id]) => id);

  if (artistIds.length === 0) {
    console.log("No matched music artists this week; no playlist to build.");
    return 0;
  }

  // Track resolution happens for BOTH --dry-run and a real run: it's
  // read-only, so --dry-run gains nothing by skipping it, and skipping it is
  // how an earlier version passed --dry-run against a deprecated endpoint with
  // a clean "would sync N tracks" that a real run then couldn't back up.
  let client: SpotifyUserApi;
  let uris: string[];
  try {
    client = api ?? spotifyUserApi();
    uris = await collectTrackUris(client, artistIds, tracksPerArtist);
  } catch (err) {
    skipped(err);
    return 0;
  }

  // Zero tracks from a non-empty artist list means every lookup came up empty
  // (or collectTrackUris would have thrown), not that the week has no music.
  // Replacing with [] would CLEAR an existing playlist the report then links.
  if (uris.length === 0) {
    skipped(`no tracks found for any of ${String(artistIds.length)} matched artist(s).`);
    return 0;
  }

  if (dryRun) {
    console.log(`[dry-run] Would sync playlist ${JSON.stringify(playlistName(monday))} with ${String(uris.length)} tracks from ${String(artistIds.length)} artists.`);
    return 0;
  }

  const storedId = (loadPlaylist(weekDir) as { playlist_id?: string }).playlist_id;
  let result: PlaylistResult;
  try {
    result = await syncPlaylist(client, monday, uris, artistIds.length, storedId);
  } catch (err) {
    skipped(err);
    return 0;
  }

  writeFileSync(join(weekDir, "_playlist.json"), `${writeJson(result)}\n`);
  console.log(`Playlist synced. ${String(result.track_count)} tracks from ${String(result.artist_count)} artists: ${result.playlist_url}`);
  return 0;
}

/** The CLI; returns the exit code (2 for bad arguments; Spotify failures are non-fatal and return 0). */
export async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "tracks-per-artist": { type: "string", default: String(DEFAULT_TRACKS_PER_ARTIST) },
        "max-artists": { type: "string", default: String(DEFAULT_MAX_ARTISTS) },
        "dry-run": { type: "boolean", default: false },
      },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const [weekDir] = parsed.positionals;
  const tracksPerArtist = Number(parsed.values["tracks-per-artist"]);
  const maxArtists = Number(parsed.values["max-artists"]);
  if (!weekDir || parsed.positionals.length > 1 || ![tracksPerArtist, maxArtists].every((n) => Number.isInteger(n) && n >= 1)) {
    console.error("usage: spotifyPlaylist.js [--tracks-per-artist N] [--max-artists N] [--dry-run] week_dir");
    return 2;
  }
  return buildPlaylist({ weekDir, tracksPerArtist, maxArtists, dryRun: parsed.values["dry-run"] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
