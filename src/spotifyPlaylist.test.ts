// Tests for spotifyPlaylist.ts (ported from tests/test_spotify_playlist.py) and the
// user-client wrapper in lib/spotifyHttp.ts. No network: a recording fake API stands
// in for the Web API, and a fake fetch exercises the HTTP wrapper itself.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimitedError, SpotifyApiError, type SpotifyUserApi, spotifyUserApi } from "./lib/spotifyHttp.js";
import {
  REPORT_BASE_URL,
  artistIdFromUrl,
  buildPlaylist,
  capArtists,
  collectTrackUris,
  findExistingPlaylist,
  matchedArtists,
  playlistDescription,
  playlistName,
  run,
  setPlaylistTracks,
  syncPlaylist,
  trackUrisForArtist,
} from "./spotifyPlaylist.js";

const MUSIC = "🎵 Music & Concerts";

// --- a recording fake of the Web API surface this script uses ---

interface Playlist {
  id: string;
  name: string;
  owner: { id: string };
  public?: boolean;
  description?: string;
}
interface Call {
  method: "GET" | "PUT" | "POST";
  path: string;
  query?: Record<string, string> | undefined;
  body?: unknown;
}

class FakeSpotify implements SpotifyUserApi {
  readonly calls: Call[] = [];
  readonly created: Playlist[] = [];
  constructor(
    private readonly opts: {
      userId?: string;
      playlists?: Playlist[];
      albumsByArtist?: Record<string, Array<{ id: string; release_date: string }>>;
      tracksByAlbum?: Record<string, Array<{ uri: string }>>;
      failArtist?: { id: string; error: Error };
    } = {},
  ) {}
  private get userId(): string {
    return this.opts.userId ?? "greg";
  }
  private get playlists(): Playlist[] {
    this.opts.playlists ??= [];
    return this.opts.playlists;
  }
  bodies(method: Call["method"], path: string): unknown[] {
    return this.calls.filter((call) => call.method === method && call.path === path).map((call) => call.body);
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    this.calls.push({ method: "GET", path, query });
    return Promise.resolve(this.route("GET", path, query) as T);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: "PUT", path, body });
    return Promise.resolve(undefined as T);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: "POST", path, body });
    if (path === "/me/playlists") {
      const { name, public: isPublic, description } = body as { name: string; public: boolean; description: string };
      const created = { id: `new-${String(this.created.length)}`, name, owner: { id: this.userId }, public: isPublic, description };
      this.created.push(created);
      this.playlists.push(created);
      return Promise.resolve(created as T);
    }
    return Promise.resolve(undefined as T);
  }

  private route(_method: string, path: string, query?: Record<string, string>): unknown {
    let match: RegExpExecArray | null;
    if (path === "/me") return { id: this.userId };
    if (path === "/me/playlists") return { items: this.playlists, next: null };
    if ((match = /^\/playlists\/([^/]+)$/.exec(path))) {
      const found = this.playlists.find((playlist) => playlist.id === match![1]);
      if (!found) throw new SpotifyApiError(404, "GET", path, "Not found");
      return found;
    }
    if ((match = /^\/artists\/([^/]+)\/albums$/.exec(path))) {
      const artistId = match[1]!;
      if (this.opts.failArtist?.id === artistId) throw this.opts.failArtist.error;
      return { items: this.opts.albumsByArtist?.[artistId] ?? [] };
    }
    if ((match = /^\/albums\/([^/]+)\/tracks$/.exec(path))) {
      return { items: (this.opts.tracksByAlbum?.[match[1]!] ?? []).slice(0, Number(query?.limit ?? 50)) };
    }
    throw new Error(`unexpected GET ${path}`);
  }
}

const owned = (id: string, name: string, userId = "greg"): Playlist => ({ id, name, owner: { id: userId } });
const album = (id: string, release_date: string): { id: string; release_date: string } => ({ id, release_date });
const track = (uri: string): { uri: string } => ({ uri });
const NAME = "2026-09-07: This Week in Philly";

describe("playlist name and description", () => {
  it("puts the date first for sortable truncation", () => {
    expect(playlistName("2026-09-07")).toBe(NAME);
  });

  it("spans Monday to Sunday and links the report", () => {
    const description = playlistDescription("2026-09-07");
    expect(description).toContain("September 7-13, 2026");
    expect(description.endsWith(`${REPORT_BASE_URL}/2026-09-07.html`)).toBe(true);
  });

  it("names both months and years when the week spans them (the Python wrote 'September 28-4, 2026')", () => {
    expect(playlistDescription("2026-09-28")).toContain("September 28-October 4, 2026");
    expect(playlistDescription("2026-12-28")).toContain("December 28, 2026-January 3, 2027");
  });
});

describe("artistIdFromUrl", () => {
  it("extracts the id", () => {
    expect(artistIdFromUrl("https://open.spotify.com/artist/6G8LVRZv0VxPuLwSQfVkEb")).toBe("6G8LVRZv0VxPuLwSQfVkEb");
  });

  it.each(["", "https://open.spotify.com/album/6G8LVRZv0VxPuLwSQfVkEb", "https://open.spotify.com/artist/", "not a url"])("is null for %j", (url) => {
    expect(artistIdFromUrl(url)).toBeNull();
  });

  it("is null for a missing url", () => {
    expect(artistIdFromUrl(undefined)).toBeNull();
  });
});

// --- matchedArtists / capArtists ---

type TopPick = { title: string; is_music?: boolean };
const pick = (title: string, is_music = true): TopPick => ({ title, is_music });
const music = (title: string): { title: string; category: string } => ({ title, category: MUSIC });
function selections(days: TopPick[][], events: Array<Array<{ title: string; category?: string }>> = []): { days: Array<{ date: string; top3: TopPick[]; events: Array<{ title: string; category?: string }>; honorable_mentions: [] }> } {
  return { days: days.map((top3, i) => ({ date: `2026-09-0${String(i + 7)}`, top3, events: events[i] ?? [], honorable_mentions: [] })) };
}
const entry = (...ids: string[]): { spotify_url: string; artists: Array<{ spotify_url: string }> } => {
  const artists = ids.map((id) => ({ spotify_url: `https://open.spotify.com/artist/${id}` }));
  return { ...artists[0]!, artists };
};

describe("matchedArtists", () => {
  it("follows report order, not _spotify.json order", () => {
    expect(matchedArtists(selections([[pick("Monday Act")], [pick("Tuesday Act")]]), { "Tuesday Act": entry("bbb"), "Monday Act": entry("aaa") })).toEqual([
      ["aaa", true],
      ["bbb", true],
    ]);
  });

  it("skips non-music and unmatched picks", () => {
    const spotify = { "A Band": entry("aaa"), "A Film Screening": entry("zzz"), "No Match Band": null };
    expect(matchedArtists(selections([[pick("A Band"), pick("A Film Screening", false), pick("No Match Band")]]), spotify)).toEqual([["aaa", true]]);
  });

  it("includes every act on a bill, and reads a pre-`artists` entry", () => {
    expect(matchedArtists(selections([[pick("A / B / C")]]), { "A / B / C": entry("aaa", "ccc") })).toEqual([["aaa", true], ["ccc", true]]);
    expect(matchedArtists(selections([[pick("Old Week Band")]]), { "Old Week Band": { spotify_url: "https://open.spotify.com/artist/aaa" } })).toEqual([["aaa", true]]);
  });

  it("adds non-Top-3 music events after the day's Top 3", () => {
    const sel = selections([[pick("Pick")]], [[music("Pick"), music("Also Playing"), { title: "A Film", category: "film" }]]);
    expect(matchedArtists(sel, { Pick: entry("aaa"), "Also Playing": entry("bbb"), "A Film": entry("zzz") })).toEqual([["aaa", true], ["bbb", false]]);
  });

  it("dedupes an artist playing twice, upgrading one who is a later Top 3 pick", () => {
    expect(matchedArtists(selections([[pick("Band at Venue A")], [pick("Band at Venue B")]]), { "Band at Venue A": entry("aaa"), "Band at Venue B": entry("aaa") })).toEqual([["aaa", true]]);
    const sel = selections([[], [pick("Band, Tuesday")]], [[music("Band, Monday")], []]);
    expect(matchedArtists(sel, { "Band, Monday": entry("aaa"), "Band, Tuesday": entry("aaa") })).toEqual([["aaa", true]]);
  });
});

describe("capArtists", () => {
  it("keeps Top 3 acts first but returns report order", () => {
    expect(capArtists([["o1", false], ["t1", true], ["o2", false], ["t2", true]], 3)).toEqual([["o1", false], ["t1", true], ["t2", true]]);
  });

  it("is a no-op under the cap and a hard limit even on Top 3 acts", () => {
    const small: Array<[string, boolean]> = [["o1", false], ["t1", true]];
    expect(capArtists(small, 50)).toEqual(small);
    const top: Array<[string, boolean]> = Array.from({ length: 5 }, (_, i) => [`t${String(i)}`, true]);
    expect(capArtists(top, 2)).toEqual(top.slice(0, 2));
  });
});

// --- track resolution ---

describe("trackUrisForArtist", () => {
  it("takes from the newest release first, re-sorting rather than trusting the API's order", async () => {
    const tracksByAlbum = { old: [track("uri:old1")], new: [track("uri:new1"), track("uri:new2")] };
    const sorted = new FakeSpotify({ albumsByArtist: { aaa: [album("old", "2020-01-01"), album("new", "2026-05-08")] }, tracksByAlbum });
    expect(await trackUrisForArtist(sorted, "aaa", 3)).toEqual(["uri:new1", "uri:new2", "uri:old1"]);
    const reversed = new FakeSpotify({ albumsByArtist: { aaa: [album("new", "2026-05-08"), album("old", "2020-01-01")] }, tracksByAlbum });
    expect(await trackUrisForArtist(reversed, "aaa", 2)).toEqual(["uri:new1", "uri:new2"]);
  });

  it("asks for albums and singles in the US market, and for at most `limit` tracks per album", async () => {
    const api = new FakeSpotify({ albumsByArtist: { aaa: [album("a", "2026-01-01")] }, tracksByAlbum: { a: [track("uri:0")] } });
    await trackUrisForArtist(api, "aaa", 3);
    expect(api.calls).toEqual([
      { method: "GET", path: "/artists/aaa/albums", query: { include_groups: "album,single", country: "US", limit: "10" } },
      { method: "GET", path: "/albums/a/tracks", query: { market: "US", limit: "3" } },
    ]);
  });

  it("keeps Spotify's order for equal dates", async () => {
    const api = new FakeSpotify({ albumsByArtist: { aaa: [album("first", "2026-01-01"), album("second", "2026-01-01")] }, tracksByAlbum: { first: [track("uri:1")], second: [track("uri:2")] } });
    expect(await trackUrisForArtist(api, "aaa", 2)).toEqual(["uri:1", "uri:2"]);
  });

  it("is empty for an artist with no albums, and stops at the limit", async () => {
    expect(await trackUrisForArtist(new FakeSpotify(), "no-releases", 3)).toEqual([]);
    const api = new FakeSpotify({ albumsByArtist: { aaa: [album("a", "2026-01-01")] }, tracksByAlbum: { a: Array.from({ length: 10 }, (_, i) => track(`uri:${String(i)}`)) } });
    expect(await trackUrisForArtist(api, "aaa", 3)).toEqual(["uri:0", "uri:1", "uri:2"]);
  });

  it("dedupes a track repeated across releases", async () => {
    const api = new FakeSpotify({
      albumsByArtist: { aaa: [album("single", "2026-05-08"), album("album", "2026-01-01")] },
      tracksByAlbum: { single: [track("uri:shared")], album: [track("uri:shared"), track("uri:unique")] },
    });
    expect(await trackUrisForArtist(api, "aaa", 3)).toEqual(["uri:shared", "uri:unique"]);
  });
});

describe("collectTrackUris", () => {
  it("concatenates across artists in order", async () => {
    const api = new FakeSpotify({
      albumsByArtist: { aaa: [album("a", "2026-01-01")], bbb: [album("b", "2026-01-01")] },
      tracksByAlbum: { a: [track("uri:a")], b: [track("uri:b")] },
    });
    expect(await collectTrackUris(api, ["aaa", "bbb"], 3)).toEqual(["uri:a", "uri:b"]);
  });

  it("propagates a failure at once, without trying the remaining artists", async () => {
    const api = new FakeSpotify({
      albumsByArtist: { aaa: [album("a", "2026-01-01")], ccc: [album("c", "2026-01-01")] },
      tracksByAlbum: { a: [track("uri:a")], c: [track("uri:c")] },
      failArtist: { id: "bbb", error: new Error("410 Gone -- deprecated endpoint") },
    });
    await expect(collectTrackUris(api, ["aaa", "bbb", "ccc"], 3)).rejects.toThrow("deprecated endpoint");
    expect(api.calls.some((call) => call.path.includes("/ccc/"))).toBe(false);
  });
});

// --- playlist lookup, tracks, sync ---

describe("findExistingPlaylist", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the stored id", async () => {
    const api = new FakeSpotify({ playlists: [owned("stored", NAME), owned("by-name", NAME)] });
    expect(await findExistingPlaylist(api, "greg", NAME, "stored")).toBe("stored");
    expect(api.calls.map((call) => call.path)).toEqual(["/playlists/stored"]);
  });

  it("falls back to an exact name match, ignoring another user's same-named playlist", async () => {
    expect(await findExistingPlaylist(new FakeSpotify({ playlists: [owned("by-name", NAME)] }), "greg", NAME, null)).toBe("by-name");
    expect(await findExistingPlaylist(new FakeSpotify({ playlists: [owned("theirs", NAME, "someone")] }), "greg", NAME, null)).toBeNull();
  });

  it("survives a stored id that was deleted (404), falling through to the name search", async () => {
    expect(await findExistingPlaylist(new FakeSpotify(), "greg", NAME, "gone")).toBeNull();
    expect(await findExistingPlaylist(new FakeSpotify({ playlists: [owned("by-name", NAME)] }), "greg", NAME, "gone")).toBe("by-name");
  });

  it("does not use a stored playlist owned by someone else", async () => {
    expect(await findExistingPlaylist(new FakeSpotify({ playlists: [owned("stored", NAME, "someone")] }), "greg", NAME, "stored")).toBeNull();
  });

  it("follows `next` links through every page of the user's playlists", async () => {
    const pages: Record<string, { items: Playlist[]; next: string | null }> = {
      "/me/playlists": { items: [owned("x", "other")], next: "https://api.spotify.com/v1/me/playlists?offset=50&limit=50" },
      "https://api.spotify.com/v1/me/playlists?offset=50&limit=50": { items: [owned("page2", NAME)], next: null },
    };
    const api: Pick<SpotifyUserApi, "get"> = { get: <T>(path: string): Promise<T> => Promise.resolve(pages[path] as T) };
    expect(await findExistingPlaylist(api, "greg", NAME, null)).toBe("page2");
  });
});

describe("setPlaylistTracks", () => {
  it("replaces rather than appends, so a second run converges", async () => {
    const api = new FakeSpotify();
    await setPlaylistTracks(api, "pid", ["uri:a", "uri:b"]);
    await setPlaylistTracks(api, "pid", ["uri:a", "uri:b"]);
    expect(api.bodies("PUT", "/playlists/pid/items")).toEqual([{ uris: ["uri:a", "uri:b"] }, { uris: ["uri:a", "uri:b"] }]);
    expect(api.bodies("POST", "/playlists/pid/items")).toEqual([]);
  });

  it("chunks past the 100-item API cap", async () => {
    const api = new FakeSpotify();
    const uris = Array.from({ length: 230 }, (_, i) => `uri:${String(i)}`);
    await setPlaylistTracks(api, "pid", uris);
    expect(api.bodies("PUT", "/playlists/pid/items")).toEqual([{ uris: uris.slice(0, 100) }]);
    expect(api.bodies("POST", "/playlists/pid/items")).toEqual([{ uris: uris.slice(100, 200) }, { uris: uris.slice(200) }]);
  });

  it("clears the playlist when given no tracks", async () => {
    const api = new FakeSpotify();
    await setPlaylistTracks(api, "pid", []);
    expect(api.bodies("PUT", "/playlists/pid/items")).toEqual([{ uris: [] }]);
  });
});

describe("syncPlaylist", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a public playlist via POST /me/playlists when none exists", async () => {
    const api = new FakeSpotify();
    const result = await syncPlaylist(api, "2026-09-07", ["uri:1", "uri:2", "uri:3"], 1);
    expect(api.created).toHaveLength(1);
    expect(api.bodies("POST", "/me/playlists")).toEqual([{ name: NAME, public: true, collaborative: false, description: playlistDescription("2026-09-07") }]);
    expect(api.calls.some((call) => call.path.startsWith("/users/"))).toBe(false);
    expect(result).toEqual({ name: NAME, playlist_id: "new-0", playlist_url: "https://open.spotify.com/playlist/new-0", artist_count: 1, track_count: 3 });
    expect(Object.keys(result)).toEqual(["name", "playlist_id", "playlist_url", "artist_count", "track_count"]);
  });

  it("reuses the stored playlist instead of creating a second, refreshing its description", async () => {
    const api = new FakeSpotify({ playlists: [owned("pid", NAME)] });
    const result = await syncPlaylist(api, "2026-09-07", ["uri:1"], 1, "pid");
    expect(api.created).toEqual([]);
    expect(result.playlist_id).toBe("pid");
    expect(api.bodies("PUT", "/playlists/pid")).toEqual([{ name: NAME, description: playlistDescription("2026-09-07") }]);
    expect(api.bodies("PUT", "/playlists/pid/items")).toEqual([{ uris: ["uri:1"] }]);
  });
});

// --- the whole step ---

describe("buildPlaylist", () => {
  let logs: string[];
  let errors: string[];
  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A week dir with one matched artist ("aaa") and a stored playlist if given. */
  function weekDir(opts: { stored?: string; spotify?: object } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "spotify-playlist-"));
    writeFileSync(join(dir, "_selections.json"), JSON.stringify(selections([[pick("A Band")]])));
    writeFileSync(join(dir, "_spotify.json"), JSON.stringify(opts.spotify ?? { "A Band": entry("aaa") }));
    if (opts.stored) writeFileSync(join(dir, "_playlist.json"), JSON.stringify({ playlist_id: opts.stored }));
    return dir;
  }
  const apiWithTracks = (extra: ConstructorParameters<typeof FakeSpotify>[0] = {}): FakeSpotify =>
    new FakeSpotify({ albumsByArtist: { aaa: [album("a", "2026-01-01")] }, tracksByAlbum: { a: [track("uri:1"), track("uri:2")] }, ...extra });

  it("syncs the playlist and writes _playlist.json in the Python's layout", async () => {
    const dir = weekDir();
    expect(await buildPlaylist({ weekDir: dir, api: apiWithTracks() })).toBe(0);
    expect(readFileSync(join(dir, "_playlist.json"), "utf8")).toBe(
      ["{", `  "name": "${NAME}",`, '  "playlist_id": "new-0",', '  "playlist_url": "https://open.spotify.com/playlist/new-0",', '  "artist_count": 1,', '  "track_count": 2', "}", ""].join("\n"),
    );
    expect(logs.at(-1)).toBe("Playlist synced. 2 tracks from 1 artists: https://open.spotify.com/playlist/new-0");
  });

  it("reuses the playlist id stored in _playlist.json", async () => {
    const dir = weekDir({ stored: "pid" });
    const api = apiWithTracks({ playlists: [owned("pid", NAME)] });
    await buildPlaylist({ weekDir: dir, api });
    expect(api.created).toEqual([]);
    expect((JSON.parse(readFileSync(join(dir, "_playlist.json"), "utf8")) as { playlist_id: string }).playlist_id).toBe("pid");
  });

  it("--dry-run resolves tracks (read-only) but never writes to Spotify or the repo", async () => {
    const dir = weekDir();
    const api = apiWithTracks();
    expect(await buildPlaylist({ weekDir: dir, api, dryRun: true })).toBe(0);
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
    expect(api.calls.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "_playlist.json"))).toBe(false);
    expect(logs).toEqual([`[dry-run] Would sync playlist "${NAME}" with 2 tracks from 1 artists.`]);
  });

  it("builds nothing, and says so, when no music artist matched", async () => {
    const dir = weekDir({ spotify: { "A Band": null } });
    const api = apiWithTracks();
    expect(await buildPlaylist({ weekDir: dir, api })).toBe(0);
    expect(api.calls).toEqual([]);
    expect(logs).toEqual(["No matched music artists this week; no playlist to build."]);
  });

  it("refuses to clear an existing playlist when no tracks turn up", async () => {
    const dir = weekDir({ stored: "pid" });
    const api = new FakeSpotify({ playlists: [owned("pid", NAME)] });
    expect(await buildPlaylist({ weekDir: dir, api })).toBe(0);
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
    expect(errors.join("\n")).toContain("SKIPPING playlist build -- no tracks found for any of 1 matched artist(s).");
    expect(existsSync(join(dir, "_playlist.json"))).toBe(true); // the stored file, untouched
  });

  it("skips (exit 0, no file) on a track-resolution failure, a rate-limit ban, or a failed sync", async () => {
    const broken = apiWithTracks({ failArtist: { id: "aaa", error: new Error("410 Gone") } });
    const dir = weekDir();
    expect(await buildPlaylist({ weekDir: dir, api: broken })).toBe(0);
    expect(errors.at(-1)).toContain("SKIPPING playlist build -- 410 Gone");

    const banned = apiWithTracks({ failArtist: { id: "aaa", error: new RateLimitedError("Spotify rate-limited this app for 85725s") } });
    expect(await buildPlaylist({ weekDir: dir, api: banned })).toBe(0);
    expect(errors.at(-1)).toContain("rate-limited this app for 85725s");

    const failingSync = apiWithTracks();
    failingSync.post = (): Promise<never> => Promise.reject(new SpotifyApiError(403, "POST", "/me/playlists", "Forbidden"));
    expect(await buildPlaylist({ weekDir: dir, api: failingSync })).toBe(0);
    expect(errors.at(-1)).toContain("HTTP 403 from Spotify POST /me/playlists");
    expect(existsSync(join(dir, "_playlist.json"))).toBe(false);
  });

  it("with no Spotify credentials in the environment, skips cleanly (exit 0, no file) through the default client", async () => {
    for (const name of ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN", "SPOTIFY_REDIRECT_URI"]) vi.stubEnv(name, "");
    const dir = weekDir();
    expect(await buildPlaylist({ weekDir: dir })).toBe(0);
    expect(errors.join("\n")).toContain("SKIPPING playlist build -- Missing required env var(s) for Spotify user auth");
    expect(existsSync(join(dir, "_playlist.json"))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("caps the artists with --max-artists, Top 3 first, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spotify-playlist-"));
    writeFileSync(join(dir, "_selections.json"), JSON.stringify(selections([[pick("A"), pick("B")]])));
    writeFileSync(join(dir, "_spotify.json"), JSON.stringify({ A: entry("aaa"), B: entry("bbb") }));
    const api = apiWithTracks();
    await buildPlaylist({ weekDir: dir, api, maxArtists: 1, dryRun: true });
    expect(logs[0]).toBe("  Capped at 1 of 2 matched artists (--max-artists).");
    expect(api.calls.some((call) => call.path.startsWith("/artists/bbb"))).toBe(false);
  });
});

describe("CLI arguments", () => {
  it("rejects a missing week dir, non-integer counts and unknown options with exit 2", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await run([])).toBe(2);
    expect(await run(["--max-artists", "lots", "data/x"])).toBe(2);
    expect(await run(["--tracks-per-artist", "0", "data/x"])).toBe(2);
    expect(await run(["--bogus", "data/x"])).toBe(2);
    vi.restoreAllMocks();
  });
});

// --- the HTTP wrapper behind the real run ---

describe("spotifyUserApi", () => {
  interface Seen {
    url: string;
    init: RequestInit;
  }
  function fakeFetch(responses: Array<Response | Error>): typeof fetch & { seen: Seen[] } {
    const seen: Seen[] = [];
    const impl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      seen.push({ url: input instanceof Request ? input.url : input.toString(), init });
      const next = responses.shift();
      if (!next) throw new Error("no response queued");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return Object.assign(impl, { seen });
  }
  const noSleep = { sleep: (): Promise<void> => Promise.resolve() };

  it("fetches one token, sends it as a bearer, and encodes the query", async () => {
    const getToken = vi.fn(() => Promise.resolve("tok"));
    const doFetch = fakeFetch([Response.json({ id: "greg" }), Response.json({ items: [] })]);
    const api = spotifyUserApi({ getToken, fetch: doFetch, ...noSleep });
    await api.get("/me");
    await api.get("/artists/a b/albums", { include_groups: "album,single", country: "US" });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(doFetch.seen[0]!.url).toBe("https://api.spotify.com/v1/me");
    expect(doFetch.seen[0]!.init.headers).toEqual({ Authorization: "Bearer tok" });
    expect(doFetch.seen[1]!.url).toBe("https://api.spotify.com/v1/artists/a b/albums?include_groups=album%2Csingle&country=US");
  });

  it("sends JSON bodies with a content type, and follows an absolute `next` URL as-is", async () => {
    const doFetch = fakeFetch([new Response(null, { status: 200 }), Response.json({ items: [] })]);
    const api = spotifyUserApi({ getToken: () => Promise.resolve("tok"), fetch: doFetch, ...noSleep });
    expect(await api.put("/playlists/p/items", { uris: ["u"] })).toBeUndefined();
    await api.get("https://api.spotify.com/v1/me/playlists?offset=50");
    expect(doFetch.seen[0]!.init.method).toBe("PUT");
    expect(doFetch.seen[0]!.init.headers).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json" });
    expect(doFetch.seen[0]!.init.body).toBe('{"uris":["u"]}');
    expect(doFetch.seen[1]!.url).toBe("https://api.spotify.com/v1/me/playlists?offset=50");
  });

  it("refreshes the token once on a 401, then retries", async () => {
    const tokens = ["old", "new"];
    const doFetch = fakeFetch([new Response("", { status: 401 }), Response.json({ id: "greg" })]);
    const api = spotifyUserApi({ getToken: () => Promise.resolve(tokens.shift()!), fetch: doFetch, ...noSleep });
    expect(await api.get("/me")).toEqual({ id: "greg" });
    expect((doFetch.seen[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer new");
  });

  it("throws SpotifyApiError carrying the status, and retries 5xx before giving up", async () => {
    const forbidden = spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: fakeFetch([new Response("nope", { status: 403 })]), ...noSleep });
    await expect(forbidden.post("/me/playlists", {})).rejects.toMatchObject({ name: "SpotifyApiError", status: 403 });
    const flaky = fakeFetch([new Response("", { status: 503 }), Response.json({ id: "greg" })]);
    expect(await spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: flaky, ...noSleep }).get("/me")).toEqual({ id: "greg" });
  });

  it("stops at once on a long Retry-After (a ban)", async () => {
    const doFetch = fakeFetch([new Response("", { status: 429, headers: { "Retry-After": "85725" } })]);
    const api = spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: doFetch, ...noSleep });
    await expect(api.get("/me")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("never retries a POST after a timeout or 5xx (it could duplicate the playlist or a chunk), but does retry a 429", async () => {
    const timedOut = fakeFetch([new DOMException("timed out", "TimeoutError"), Response.json({ id: "dup" })]);
    const api = spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: timedOut, ...noSleep });
    await expect(api.post("/me/playlists", {})).rejects.toThrow("timed out");
    expect(timedOut.seen).toHaveLength(1);

    const serverError = fakeFetch([new Response("", { status: 503 }), Response.json({ id: "dup" })]);
    await expect(spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: serverError, ...noSleep }).post("/playlists/p/items", {})).rejects.toMatchObject({ status: 503 });
    expect(serverError.seen).toHaveLength(1);

    const limited = fakeFetch([new Response("", { status: 429, headers: { "Retry-After": "1" } }), Response.json({ id: "ok" })]);
    expect(await spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: limited, ...noSleep }).post("/me/playlists", {})).toEqual({ id: "ok" });
  });

  it("retries a GET or PUT after a network error", async () => {
    const flaky = fakeFetch([new TypeError("fetch failed"), new Response(null, { status: 200 })]);
    await spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: flaky, ...noSleep }).put("/playlists/p/items", { uris: [] });
    expect(flaky.seen).toHaveLength(2);
  });

  it("surfaces a token failure on a 401 refresh, and refuses to send the token to another host", async () => {
    let calls = 0;
    const getToken = (): Promise<string> => (++calls === 1 ? Promise.resolve("old") : Promise.reject(new Error("invalid_grant")));
    const api = spotifyUserApi({ getToken, fetch: fakeFetch([new Response("", { status: 401 })]), ...noSleep });
    await expect(api.get("/me")).rejects.toThrow("invalid_grant");

    const doFetch = fakeFetch([]);
    await expect(spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: doFetch, ...noSleep }).get("https://evil.example/v1/me/playlists")).rejects.toThrow("refusing to send a Spotify token");
    expect(doFetch.seen).toEqual([]);
  });

  it("pages through /me/playlists end to end, following Spotify's absolute `next` URL", async () => {
    const next = "https://api.spotify.com/v1/me/playlists?offset=50&limit=50";
    const doFetch = fakeFetch([
      Response.json({ items: [owned("x", "other")], next }),
      Response.json({ items: [owned("page2", NAME)], next: null }),
    ]);
    const api = spotifyUserApi({ getToken: () => Promise.resolve("t"), fetch: doFetch, ...noSleep });
    expect(await findExistingPlaylist(api, "greg", NAME, null)).toBe("page2");
    expect(doFetch.seen.map((call) => call.url)).toEqual(["https://api.spotify.com/v1/me/playlists?limit=50", next]);
  });
});
