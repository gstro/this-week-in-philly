/**
 * Batch Spotify artist lookup for every music act in a week's report.
 * Rewrite of scripts/spotify_lookup.py.
 *
 * Reads data/YYYY-MM-DD/_selections.json, looks up Spotify artist pages for
 * every music event (common.musicEvents: Top 3 picks by their is_music flag,
 * everything else by the Music & Concerts category), and writes
 * data/YYYY-MM-DD/_spotify.json as
 *
 *     {title: {"artists": [{"matched_text", "spotify_url"}, ...],
 *              "matched_text": ..., "spotify_url": ...} | null}
 *
 * `artists` holds every act on the bill that matched, in listed order;
 * `spotify_url`/`matched_text` repeat its first entry and are what htmlRender
 * links (one act per Top 3 pick; everything else exists for
 * spotify_playlist). `matched_text` is the substring of the title to
 * hyperlink -- often not the whole title ("Die Sexual" within "Gothic night:
 * Die Sexual, Ronnie Stone & DJ Baby Berlin").
 *
 * No match -> null, never a guess: only an exact case-insensitive artist-name
 * match against a Spotify search result counts.
 *
 * Client Credentials (app-only) on purpose: this only searches, and has no
 * refresh token to expire. spotifyPlaylist needs the user-authorized client
 * (common.getSpotifyUserClient) because only that can write a playlist.
 *
 * Divergences from the Python:
 * - Names compare with toLowerCase(), not Python's casefold(), which also
 *   folds e.g. "ß" to "ss". An artist name differing from a title only that
 *   way no longer matches.
 * - A search result without a string `name` or Spotify URL is skipped; it
 *   raised inside a worker thread and crashed the whole lookup.
 * - Spotify is called directly with fetch: network errors, 429 and 5xx are
 *   retried up to 3 times (honouring a Retry-After of up to 60s), with a 10s
 *   timeout per request (spotipy: 5s). A token that can't be obtained, or a
 *   longer rate-limit ban, fails the run with exit 1 and writes nothing. The
 *   Python caught an auth failure per search and wrote every title as null,
 *   and slept through any ban (one seen 2026-10-10 lasted ~24h).
 * - Regexes use JS semantics: `\b` is ASCII-only (Python's is Unicode-aware)
 *   and `\s` covers a slightly different whitespace set. Candidate groups
 *   were identical on all 4,495 real titles in data/ (2026-10-10).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { type MusicSelections, loadSelections, musicEvents } from "./common.js";
import { writeJson } from "./lib/json.js";

// Splits a compound listing title ("A w/ B, C" / "A & B" / "A -- subtitle")
// so every act on the bill can be tried. Not ":" -- a "Subtitle: Act, Act2"
// prefix is handled separately, since the acts follow the colon there.
// Symbol separators (+, x, /, |) need surrounding spaces so "AC/DC" and
// "BIG|BRAVE" never split. The comma alternative swallows a following
// connector word ("The Body, with BIG|BRAVE" -> "The Body" / "BIG|BRAVE").
const SEPARATOR = /\s*(?:,\s*(?:with\b|w\/|and\b|&)?| & | and | w\/ | with | — | – | - | \+ | x | \/ | \| )\s*/i;

// A trailing "@ Venue Name" -- removed before splitting, not split out.
const VENUE_SUFFIX = /\s+@\s+.*$/;

// Trailing "!!!!!" noise. Not ".", or "M.I.A." would never exact-match.
const TRAILING_PUNCT = /[!?\s]+$/;

// A trailing parenthetical, tried both kept ("Durex (mtl)", where it
// disambiguates the act) and stripped ("SKEKSIS (RVA)" -> also "SKEKSIS").
const TRAILING_PAREN = /(?:\s*\([^()]*\))+$/;

// DIY flyers list acts back to back with only a "(city)" tag between them
// ("VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC"): whitespace after a closing
// paren, followed by a word, is a boundary. Defers to a connector word
// ("Foo (bar) with Baz") and to symbol separators ("(Denton) / Sweepers").
const PAREN_BOUNDARY = /(?<=\))\s+(?!with\b|w\/|and\b|&)(?=[A-Za-z0-9])/i;

// A trailing ensemble-size word ("DoYeon Kim Quartet" -> also "DoYeon Kim").
// Not "Band"/"Orchestra": "Dave Matthews Band" is a distinct artist from
// "Dave Matthews", so stripping those risks linking the wrong one.
const ENSEMBLE_SUFFIX = /\s+(?:Quartet|Trio|Duo|Quintet|Sextet|Septet|Ensemble)\s*$/i;

// Bounds Spotify calls per title; must cover a real seven-act hardcore bill
// plus variants (8, the single-headliner era's value, cut those off).
export const MAX_CANDIDATES = 20;

// Boilerplate byproducts of full splitting ("... & More!" -> "More"). Not
// act names, and trying them risks an exact-name hit on an unrelated real
// artist -- a wrong link in a published report. A literal stop-list, since
// real one-word acts in this data ("Ditch", "Bane") are just as short.
const NOISE = new Set(["more", "and more", "screening", "performance", "benefit show", "special guests", "guests", "tba", "dj set", "and friends", "free"]);

const fold = (text: string): string => text.toLowerCase();

/**
 * Search candidates, grouped by act, most to least specific within a group.
 *
 * Group 0 is the full title alone. Each later group is one act from the
 * bill, left to right, followed by its fallback variants (parenthetical
 * stripped, ensemble word stripped). findSpotifyMatches takes the first hit
 * per group, so "SKEKSIS (RVA)" beats "SKEKSIS" and an act never gets two
 * links. A colon splits titles both ways in practice ("Gothic night: Die
 * Sexual, ..." vs "LAYER MEAT, SPECTRAL FORCES: A Benefit Show"), so both
 * sides are tried; exact matching is what keeps that safe. Candidates
 * already seen are dropped, and the total is capped at MAX_CANDIDATES.
 */
export function candidateGroups(rawTitle: string): string[][] {
  const title = rawTitle.trim();
  const groups = [[title]];
  const seen = new Set([title]);
  let count = 1;

  const cleaned = title.replace(VENUE_SUFFIX, "").replace(TRAILING_PUNCT, "").trim();
  const colon = cleaned.indexOf(":");
  const segments = colon === -1 ? [cleaned] : [cleaned.slice(0, colon).trim(), cleaned.slice(colon + 1).trim()];

  for (const segment of segments) {
    for (const chunk of segment.split(PAREN_BOUNDARY)) {
      for (const rawPiece of chunk.split(SEPARATOR)) {
        const piece = rawPiece.trim();
        if (!piece) continue;
        const variants = [piece];
        const stripped = piece.replace(TRAILING_PAREN, "").trim();
        if (stripped && stripped !== piece) variants.push(stripped);
        for (const variant of [...variants]) {
          const unsuffixed = variant.replace(ENSEMBLE_SUFFIX, "").trim();
          if (unsuffixed && unsuffixed !== variant) variants.push(unsuffixed);
        }

        const group = variants.filter((variant) => {
          if (NOISE.has(fold(variant)) || seen.has(variant)) return false;
          seen.add(variant);
          return true;
        });
        if (group.length === 0) continue;
        const kept = group.slice(0, MAX_CANDIDATES - count);
        groups.push(kept);
        count += kept.length;
        if (count >= MAX_CANDIDATES) return groups;
      }
    }
  }
  return groups;
}

/** What one Spotify artist search returns that we use. */
export interface Artist {
  name?: unknown;
  external_urls?: { spotify?: unknown };
  followers?: { total?: unknown } | null;
}

/** Searches Spotify for artists named like `query`; throws on failure. */
export type ArtistSearch = (candidate: string) => Promise<Artist[]>;

/** The Spotify URL of the search result named exactly `candidate`, if any. */
export async function exactMatchUrl(search: ArtistSearch, candidate: string): Promise<string | null> {
  let items: Artist[];
  try {
    items = await search(candidate);
  } catch (err) {
    // A ban would fail every remaining search too; carrying on would write
    // them all as "no match".
    if (err instanceof RateLimitedError) throw err;
    // One candidate's search failing shouldn't skip the rest.
    console.error(`  Spotify search failed for ${JSON.stringify(candidate)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  // Every returned result is checked, not just the top one: Spotify's
  // ranking can put a fuzzy same-named result above the exact match. The
  // exact-name requirement itself never loosens.
  const exact = items.filter(
    (artist): artist is Artist & { name: string; external_urls: { spotify: string } } =>
      typeof artist.name === "string" && typeof artist.external_urls?.spotify === "string" && fold(artist.name.trim()) === fold(candidate),
  );
  if (exact.length === 0) return null;
  if (exact.length === 1) return exact[0]!.external_urls.spotify;

  // Name clashes (several real "Lee Fields"): Spotify's order drifts between
  // runs, so the most-followed wins. Live search results carry no
  // `followers` today (2026-10), so every key is -1 and the first --
  // Spotify's order -- is kept, as before the tie-break.
  const followers = (artist: Artist): number => (typeof artist.followers?.total === "number" ? artist.followers.total : -1);
  const chosen = exact.reduce((best, artist) => (followers(artist) > followers(best) ? artist : best));
  const url = chosen.external_urls.spotify;
  console.error(`  ${String(exact.length)} exact matches for ${JSON.stringify(candidate)}; chose ${url} (${String(followers(chosen))} followers)`);
  return url;
}

export interface Match {
  spotify_url: string;
  matched_text: string;
}

/**
 * One match per act on the bill, in listed order, deduped by URL. If the
 * full title is itself an exact artist name, that's the only match: "Simon &
 * Garfunkel" is one act, and splitting it would add two that merely share
 * the words.
 */
export async function findSpotifyMatches(search: ArtistSearch, title: string): Promise<Match[]> {
  const matches: Match[] = [];
  const seenUrls = new Set<string>();
  for (const [index, group] of candidateGroups(title).entries()) {
    for (const candidate of group) {
      const url = await exactMatchUrl(search, candidate);
      if (url) {
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          matches.push({ spotify_url: url, matched_text: candidate });
        }
        break;
      }
    }
    if (index === 0 && matches.length > 0) return matches;
  }
  return matches;
}

export type SpotifyEntry = (Match & { artists: Match[] }) | null;

/** The _spotify.json value for one title (see the module header). */
export function spotifyEntry(matches: Match[]): SpotifyEntry {
  return matches.length === 0 ? null : { ...matches[0]!, artists: matches };
}

/** Every music event title in the report, deduped, in report order. */
export function musicTitles(selections: MusicSelections): string[] {
  return [...new Set(musicEvents(selections).map(([title]) => title))];
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
// A Retry-After longer than this is a ban, not a blip (one seen 2026-10-10
// was 85,725s, ~24h, after a day of repeated test runs). The lookup stops
// rather than waiting it out -- spotipy sleeps through any Retry-After, so
// the Python would hang until the job timed out.
const MAX_RETRY_AFTER_S = 60;

/** Spotify has banned this app for longer than a run should wait; the whole lookup stops. */
export class RateLimitedError extends Error {
  override name = "RateLimitedError";
}

export interface HttpDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

/** One request with spotipy-like resilience: retries network errors, 429 and 5xx (honouring Retry-After), with a timeout. */
async function resilientFetch(url: string, init: () => RequestInit, { fetch: doFetch = fetch, sleep: wait = sleep }: HttpDeps): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await doFetch(url, { ...init(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await wait(300 * 2 ** attempt);
      continue;
    }
    if (!RETRY_STATUSES.has(response.status) || attempt >= MAX_RETRIES) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    await response.body?.cancel();
    if (retryAfter > MAX_RETRY_AFTER_S) throw new RateLimitedError(`Spotify rate-limited this app for ${String(retryAfter)}s`);
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 300 * 2 ** attempt);
  }
}

/**
 * An {@link ArtistSearch} using Spotify's Client Credentials flow. Resolves
 * once the first token is in hand, so bad credentials or an unreachable
 * accounts service fail the run up front (the Python caught that per search
 * and wrote every title as null). The token is refreshed a minute before it
 * expires, or on a 401.
 */
export async function clientCredentialsSearch(clientId: string, clientSecret: string, deps: HttpDeps = {}): Promise<ArtistSearch> {
  const now = (): number => Date.now();
  const requestToken = async (): Promise<{ value: string; expiresAt: number }> => {
    const response = await resilientFetch(
      "https://accounts.spotify.com/api/token",
      () => ({
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      }),
      deps,
    );
    if (!response.ok) throw new Error(`Spotify token request failed: ${String(response.status)} ${await response.text()}`);
    const body = (await response.json()) as { access_token: string; expires_in?: number };
    return { value: body.access_token, expiresAt: now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  };

  let token = await requestToken();
  let refreshing: Promise<void> | undefined;
  const refresh = (): Promise<void> =>
    (refreshing ??= requestToken()
      .then((fresh) => {
        token = fresh;
      })
      .finally(() => {
        refreshing = undefined;
      }));

  return async (candidate) => {
    const url = `https://api.spotify.com/v1/search?${new URLSearchParams({ q: `artist:"${candidate}"`, type: "artist", limit: "5" }).toString()}`;
    if (now() >= token.expiresAt) await refresh();
    let response = await resilientFetch(url, () => ({ headers: { Authorization: `Bearer ${token.value}` } }), deps);
    if (response.status === 401) {
      await response.body?.cancel();
      await refresh();
      response = await resilientFetch(url, () => ({ headers: { Authorization: `Bearer ${token.value}` } }), deps);
    }
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} from Spotify search: ${await response.text()}`);
    const body = (await response.json()) as { artists?: { items?: unknown } };
    return Array.isArray(body.artists?.items) ? (body.artists.items as Artist[]) : [];
  };
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Python's sort_keys order (by code point), so committed files don't churn. */
function byCodePoint(a: string, b: string): number {
  const [x, y] = [[...a], [...b]];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

export function formatSpotifyJson(results: Record<string, SpotifyEntry>): string {
  const titles = Object.keys(results).sort(byCodePoint);
  if (titles.length === 0) return "{}";
  const sortedMatch = ({ matched_text, spotify_url }: Match): Match => ({ matched_text, spotify_url });
  // Assembled by hand: a JS object would hoist integer-like titles ("2024")
  // ahead of the rest whatever order they were inserted in.
  const lines = titles.map((title) => {
    const entry = results[title]!;
    const value = writeJson(entry && { artists: entry.artists.map(sortedMatch), ...sortedMatch(entry) }).replace(/\n/g, "\n  ");
    return `  ${JSON.stringify(title)}: ${value}`;
  });
  return `{\n${lines.join(",\n")}\n}`;
}

export interface RunOptions {
  weekDir: string;
  maxWorkers?: number;
  /** Defaults to Client Credentials from SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET. */
  search?: ArtistSearch;
  /** For the default search's HTTP calls (tests). */
  http?: HttpDeps;
}

/** Writes _spotify.json; returns the exit code. */
export async function lookupWeek({ weekDir, maxWorkers = 5, search, http = {} }: RunOptions): Promise<number> {
  const titles = musicTitles(loadSelections(weekDir) as MusicSelections);
  const outPath = join(weekDir, "_spotify.json");
  if (titles.length === 0) {
    writeFileSync(outPath, writeJson({}));
    console.log("Spotify lookup complete. 0 matched, 0 not found (no music events).");
    return 0;
  }

  if (!search) {
    const clientId = process.env["SPOTIFY_CLIENT_ID"];
    const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"];
    if (!clientId || !clientSecret) {
      console.error("Missing SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET env vars.");
      return 1;
    }
    try {
      search = await clientCredentialsSearch(clientId, clientSecret, http);
    } catch (err) {
      // Nothing written: an all-null _spotify.json would strip every link from the report.
      console.error(`Spotify authentication failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const lookup = search;

  let entries: SpotifyEntry[];
  try {
    entries = await mapLimit(titles, maxWorkers, async (title) => spotifyEntry(await findSpotifyMatches(lookup, title)));
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    // Nothing written: a half-null _spotify.json would quietly drop links.
    console.error(`Spotify lookup aborted: ${err.message}. _spotify.json not written.`);
    return 1;
  }
  const results = Object.fromEntries(titles.map((title, i) => [title, entries[i]!]));
  writeFileSync(outPath, formatSpotifyJson(results));

  const found = entries.filter((entry) => entry !== null);
  const artists = found.reduce((sum, entry) => sum + entry.artists.length, 0);
  console.log(
    `Spotify lookup complete. ${String(found.length)} matched (${String(artists)} artists), ${String(entries.length - found.length)} not found.`,
  );
  return 0;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { "max-workers": { type: "string", default: "5" } } });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const [weekDir] = parsed.positionals;
  const maxWorkers = Number(parsed.values["max-workers"]);
  if (!weekDir || parsed.positionals.length > 1 || !Number.isInteger(maxWorkers) || maxWorkers < 1) {
    console.error("usage: spotifyLookup.js [--max-workers N] week_dir");
    return 2;
  }
  return lookupWeek({ weekDir, maxWorkers });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
