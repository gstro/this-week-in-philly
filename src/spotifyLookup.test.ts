// Tests for spotifyLookup.ts, ported from tests/test_spotify_lookup.py (offline
// tests; the live canary was run by hand -- see docs/TS_PORT.md).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MusicSelections, musicEvents } from "./common.js";
import {
  type Artist,
  type ArtistSearch,
  candidateGroups,
  findSpotifyMatches,
  formatSpotifyJson,
  lookupWeek,
  musicTitles,
  spotifyEntry,
} from "./spotifyLookup.js";

const candidateNames = (title: string): string[] => candidateGroups(title).flat();

describe("candidate names", () => {
  it("always includes the full title first", () => {
    expect(candidateNames("Some Show Title")[0]).toBe("Some Show Title");
  });

  it("splits on a leading colon prefix, trying every act in order", () => {
    const title = "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin";
    expect(candidateNames(title)).toEqual([title, "Gothic night", "Die Sexual", "Ronnie Stone", "DJ Baby Berlin"]);
  });

  it("splits on a trailing colon subtitle", () => {
    const title = "LAYER MEAT, SPECTRAL FORCES: A Benefit Show";
    const candidates = candidateNames(title);
    expect(candidates[0]).toBe(title);
    expect(candidates).toContain("LAYER MEAT");
    expect(candidates).toContain("SPECTRAL FORCES");
  });

  it("splits on commas without a colon", () => {
    const title = "CONTRACHARGE (chi), AGONESIAC, DISCLAIM";
    expect(candidateNames(title)).toEqual([title, "CONTRACHARGE (chi)", "CONTRACHARGE", "AGONESIAC", "DISCLAIM"]);
  });

  it("doesn't duplicate an identical head from both sides of a colon", () => {
    expect(candidateNames("Foo: Foo")).toEqual(["Foo: Foo", "Foo"]);
  });

  it("splits on &, and, w/, with", () => {
    for (const sep of [" & ", " and ", " w/ ", " with "]) {
      const candidates = candidateNames(`Die Sexual${sep}The Rest`);
      expect(candidates[1]).toBe("Die Sexual");
      expect(candidates).toContain("The Rest");
    }
  });

  it("returns only the full title when there's no separator", () => {
    expect(candidateNames("Just One Act")).toEqual(["Just One Act"]);
  });

  it("splits on +, and on x case-insensitively, many ways", () => {
    expect(candidateNames("Quicksand + Bane")).toEqual(["Quicksand + Bane", "Quicksand", "Bane"]);
    const title = "Fraternal Twin x Ditch x Lo Fives x Wax Girl";
    expect(candidateNames(title)).toEqual([title, "Fraternal Twin", "Ditch", "Lo Fives", "Wax Girl"]);
  });

  it("splits on a spaced / or | but not inside a real name", () => {
    const title = "Gay Cum Daddies (Denton) / Sweepers / Good Pollution / Gr3yboy";
    expect(candidateNames(title)).toEqual([title, "Gay Cum Daddies (Denton)", "Gay Cum Daddies", "Sweepers", "Good Pollution", "Gr3yboy"]);
    expect(candidateNames("AC/DC")).toEqual(["AC/DC"]);
    expect(candidateNames("Successor Tour | Spike Hellis")).toEqual(["Successor Tour | Spike Hellis", "Successor Tour", "Spike Hellis"]);
    expect(candidateNames("BIG|BRAVE")).toEqual(["BIG|BRAVE"]);
  });

  it("swallows a connector word after a comma", () => {
    const title = "The Body, with BIG|BRAVE, Carnivorous Bells";
    expect(candidateNames(title)).toEqual([title, "The Body", "BIG|BRAVE", "Carnivorous Bells"]);
  });

  it("strips a trailing venue suffix and punctuation noise", () => {
    const title = "the pleasant uprising @ Wooden Shoe Books!!!!!";
    expect(candidateNames(title)).toEqual([title, "the pleasant uprising"]);
  });

  it("tries a trailing parenthetical both kept and stripped, kept first", () => {
    expect(candidateNames("DoYeon Kim Quartet (Ars Nova Workshop)")).toContain("DoYeon Kim Quartet");
    const candidates = candidateNames("SKEKSIS (RVA), NIGHTFALL, SEDIMENT, DISKRITIK");
    expect(candidates.indexOf("SKEKSIS (RVA)")).toBeLessThan(candidates.indexOf("SKEKSIS"));
    expect(candidates).toEqual(expect.arrayContaining(["NIGHTFALL", "SEDIMENT", "DISKRITIK"]));
  });

  it("splits on a dash and x, dropping boilerplate words", () => {
    const candidates = candidateNames("REPO MAN X CIRCLE JERKS – Screening & Performance");
    expect(candidates).toEqual(expect.arrayContaining(["REPO MAN", "CIRCLE JERKS"]));
    expect(candidates).not.toContain("Screening");
    expect(candidates).not.toContain("Performance");
  });

  it("filters generic words via the stop-list", () => {
    const candidates = candidateNames("Benefit Show w/ Godcaster, Fib, Taurus Judge, & More!");
    expect(candidates).toEqual(expect.arrayContaining(["Godcaster", "Fib", "Taurus Judge"]));
    expect(candidates).not.toContain("More");
    expect(candidates).not.toContain("& More");
  });

  it("splits on the boundary after a (city) tag, deferring to connectors and symbols", () => {
    const candidates = candidateNames("VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC + AGONESIAC @ Cousin Dannys");
    expect(candidates).toEqual(expect.arrayContaining(["VOIDHAMMER", "HARSH REALM", "DIURETIC", "AGONESIAC"]));
    expect(candidateNames("Foo (bar) with Baz")).toContain("Baz");
    expect(candidateNames("Foo (bar) with Baz")).not.toContain("with Baz");
    expect(candidateNames("Gay Cum Daddies (Denton) / Sweepers")).not.toContain("/ Sweepers");
  });

  it("doesn't split after a lone trailing parenthetical", () => {
    const title = "DoYeon Kim Quartet (Ars Nova Workshop)";
    expect(candidateNames(title)).toEqual([title, "DoYeon Kim Quartet", "DoYeon Kim"]);
  });

  it("strips an ensemble-size word, but not Band or Orchestra", () => {
    expect(candidateNames("DoYeon Kim Quartet")).toEqual(["DoYeon Kim Quartet", "DoYeon Kim"]);
    expect(candidateNames("Dave Matthews Band")).toEqual(["Dave Matthews Band"]);
  });

  it("keeps the periods of an initialism", () => {
    expect(candidateNames("M.I.A. @ Union Transfer")).toEqual(["M.I.A. @ Union Transfer", "M.I.A."]);
  });

  it("caps the total at 20, yet covers a seven-act bill", () => {
    expect(candidateNames(Array.from({ length: 30 }, (_, i) => `Act${String(i)}`).join(", "))).toHaveLength(20);
    const acts = ["Missing Link (NJ)", "King 9", "Criminal Instinct", "Morning Again", "Scorched Earth Policy", "Azshara", "Unmoved"];
    expect(candidateNames(acts.join(" / "))).toEqual(expect.arrayContaining([...acts, "Missing Link"]));
  });

  it("only ever yields substrings of the raw title (htmlRender links by indexOf)", () => {
    const titles = [
      "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin",
      "LAYER MEAT, SPECTRAL FORCES: A Benefit Show",
      "CONTRACHARGE (chi), AGONESIAC, DISCLAIM",
      "Foo: Foo",
      "Quicksand + Bane",
      "Fraternal Twin x Ditch x Lo Fives x Wax Girl",
      "Gay Cum Daddies (Denton) / Sweepers / Good Pollution / Gr3yboy",
      "The Body, with BIG|BRAVE, Carnivorous Bells",
      "the pleasant uprising @ Wooden Shoe Books!!!!!",
      "SKEKSIS (RVA), NIGHTFALL, SEDIMENT, DISKRITIK",
      "M.I.A. @ Union Transfer",
      "VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC + AGONESIAC @ Cousin Dannys",
      "Foo (bar) with Baz",
    ];
    for (const title of titles) for (const candidate of candidateNames(title)) expect(title, candidate).toContain(candidate);
  });
});

describe("candidate groups", () => {
  it("puts the full title alone in the first group", () => {
    expect(candidateGroups("Quicksand + Bane")).toEqual([["Quicksand + Bane"], ["Quicksand"], ["Bane"]]);
  });

  it("keeps an act's fallback variants in its own group", () => {
    const title = "SKEKSIS (RVA), DoYeon Kim Quartet";
    expect(candidateGroups(title)).toEqual([[title], ["SKEKSIS (RVA)", "SKEKSIS"], ["DoYeon Kim Quartet", "DoYeon Kim"]]);
  });

  it("truncates the last group at the cap", () => {
    const groups = candidateGroups(Array.from({ length: 30 }, (_, i) => `Act${String(i)} (x)`).join(", "));
    expect(groups.flat()).toHaveLength(20);
  });
});

const MUSIC = "🎵 Music & Concerts";
const FILM = "🎬 Film & Cinema";
type Day = MusicSelections["days"][number];
const day = (top3: Day["top3"], events: NonNullable<Day["events"]>, honorable_mentions: NonNullable<Day["honorable_mentions"]> = []): Day => ({ top3, events, honorable_mentions });

describe("musicTitles", () => {
  it("takes top3 by is_music and the rest by category", () => {
    const selections = {
      days: [
        day(
          [{ title: "Music Pick", is_music: true }, { title: "Reading", is_music: false }],
          [
            { title: "Music Pick", category: MUSIC },
            { title: "Reading", category: "📚 Literary" },
            { title: "Other Band", category: MUSIC },
            { title: "A Film", category: FILM },
          ],
        ),
        day([{ title: "Another Band", is_music: true }], [{ title: "Another Band", category: MUSIC }]),
      ],
    };
    expect(musicTitles(selections)).toEqual(["Music Pick", "Other Band", "Another Band"]);
    expect(musicEvents(selections)).toEqual([["Music Pick", true], ["Other Band", false], ["Another Band", true]]);
  });

  it("trusts is_music false over a music category, and includes is_music outside it", () => {
    expect(musicTitles({ days: [day([{ title: "Karaoke Night", is_music: false }], [{ title: "Karaoke Night", category: MUSIC }])] })).toEqual([]);
    expect(musicTitles({ days: [day([{ title: "Silent Film w/ Live Score", is_music: true }], [{ title: "Silent Film w/ Live Score", category: FILM }])] })).toEqual([
      "Silent Film w/ Live Score",
    ]);
  });

  it("orders honorable mentions (SOLD OUT stripped) before the rest of the day", () => {
    const selections = {
      days: [day([], [{ title: "Early Show", category: MUSIC }, { title: "Mentioned Band", category: MUSIC }], [{ title: "Mentioned Band (SOLD OUT)" }])],
    };
    expect(musicTitles(selections)).toEqual(["Mentioned Band", "Early Show"]);
  });

  it("dedupes a title on two days, and treats a missing is_music as false", () => {
    const repeat = day([], [{ title: "Two Night Stand", category: MUSIC }]);
    expect(musicTitles({ days: [repeat, repeat] })).toEqual(["Two Night Stand"]);
    expect(musicTitles({ days: [day([{ title: "No Flag Set" }], [])] })).toEqual([]);
  });
});

/** A fake search: candidate -> results (or an error to throw); records queries. */
function fakeSearch(byQuery: Record<string, Artist[] | Error>): ArtistSearch & { queries: string[] } {
  const queries: string[] = [];
  const search = (candidate: string): Promise<Artist[]> => {
    queries.push(candidate);
    const result = byQuery[candidate] ?? [];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return Object.assign(search, { queries });
}

const artist = (name: string, url = "https://open.spotify.com/artist/xyz", followers?: number | null): Artist => ({
  name,
  external_urls: { spotify: url },
  ...(followers !== undefined && { followers: { total: followers } }),
});
const url = (name: string): string => `https://open.spotify.com/artist/${name.replace(/ /g, "")}`;
const texts = (matches: Array<{ matched_text: string }>): string[] => matches.map((match) => match.matched_text);

describe("findSpotifyMatches", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hits on the full title", async () => {
    expect(await findSpotifyMatches(fakeSearch({ "Die Sexual": [artist("Die Sexual")] }), "Die Sexual")).toEqual([
      { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "Die Sexual" },
    ]);
  });

  it("falls through to a later candidate", async () => {
    const matches = await findSpotifyMatches(fakeSearch({ "Die Sexual": [artist("Die Sexual")] }), "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin");
    expect(texts(matches)).toEqual(["Die Sexual"]);
  });

  it("requires an exact name, case-insensitively, checking every result", async () => {
    expect(await findSpotifyMatches(fakeSearch({ "Die Sexual": [artist("Die Sexual (Tribute Band)")] }), "Die Sexual")).toEqual([]);
    expect(texts(await findSpotifyMatches(fakeSearch({ "Die Sexual": [artist("DIE SEXUAL")] }), "Die Sexual"))).toEqual(["Die Sexual"]);
    expect(texts(await findSpotifyMatches(fakeSearch({ "The Body": [artist("The Body (Karaoke Tribute)"), artist("The Body")] }), "The Body"))).toEqual(["The Body"]);
    expect(await findSpotifyMatches(fakeSearch({}), "Totally Unknown Act")).toEqual([]);
  });

  it("carries on past a failed search, and past a malformed result", async () => {
    const title = "Die Sexual & The Rest";
    const search = fakeSearch({ [title]: new Error("Spotify API is down"), "Die Sexual": [{ name: 7 }, artist("Die Sexual")] });
    expect(texts(await findSpotifyMatches(search, title))).toEqual(["Die Sexual"]);
  });

  it("returns every act on the bill in listed order", async () => {
    const search = fakeSearch({ "Gutter Pearl": [artist("Gutter Pearl", url("Gutter Pearl"))], "Sensor Ghost": [artist("Sensor Ghost", url("Sensor Ghost"))] });
    expect(texts(await findSpotifyMatches(search, "Noun / Sensor Ghost / Northern Liberties / Gutter Pearl"))).toEqual(["Sensor Ghost", "Gutter Pearl"]);
  });

  it("doesn't split a title that is itself an act", async () => {
    const search = fakeSearch({
      "Simon & Garfunkel": [artist("Simon & Garfunkel", url("SG"))],
      Simon: [artist("Simon", url("Simon"))],
      Garfunkel: [artist("Garfunkel", url("Garfunkel"))],
    });
    expect(texts(await findSpotifyMatches(search, "Simon & Garfunkel"))).toEqual(["Simon & Garfunkel"]);
    expect(search.queries).toEqual(["Simon & Garfunkel"]);
  });

  it("takes only the first hit per act, and dedupes acts resolving to one artist", async () => {
    const search = fakeSearch({ "SKEKSIS (RVA)": [artist("SKEKSIS (RVA)", url("a"))], SKEKSIS: [artist("SKEKSIS", url("b"))] });
    expect(texts(await findSpotifyMatches(search, "SKEKSIS (RVA), NIGHTFALL"))).toEqual(["SKEKSIS (RVA)"]);
    expect(search.queries).not.toContain("SKEKSIS");
    const same = url("same");
    expect(texts(await findSpotifyMatches(fakeSearch({ Foo: [artist("Foo", same)], FOO: [artist("foo", same)] }), "Foo, FOO"))).toEqual(["Foo"]);
  });
});

describe("tie-break between exact matches", () => {
  const leeFields = async (artists: Artist[]): Promise<string[]> =>
    (await findSpotifyMatches(fakeSearch({ "Lee Fields": artists }), "Lee Fields")).map((match) => match.spotify_url);
  const errors = vi.fn();
  beforeEach(() => {
    errors.mockReset();
    vi.spyOn(console, "error").mockImplementation(errors);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks the most followers, else keeps Spotify's order", async () => {
    expect(await leeFields([artist("Lee Fields", "u/small", 10), artist("Lee Fields", "u/big", 5000)])).toEqual(["u/big"]);
    expect(await leeFields([artist("Lee Fields", "u/first", 7), artist("Lee Fields", "u/second", 7)])).toEqual(["u/first"]);
    expect(await leeFields([artist("Lee Fields", "u/first"), artist("Lee Fields", "u/second")])).toEqual(["u/first"]);
    expect(await leeFields([artist("Lee Fields", "u/first", null), artist("Lee Fields", "u/second", 1)])).toEqual(["u/second"]);
  });

  it("never lets a non-exact result win on followers", async () => {
    expect(await leeFields([artist("Lee Fields Tribute", "u/fuzzy", 999999), artist("Lee Fields", "u/a", 1), artist("Lee Fields", "u/b", 2)])).toEqual(["u/b"]);
  });

  it("logs only when two or more results match exactly", async () => {
    await leeFields([artist("Lee Fields", "u/only", 1), artist("Lee Fields Tribute")]);
    expect(errors).not.toHaveBeenCalled();
    await leeFields([artist("Lee Fields", "u/a", 1), artist("Lee Fields", "u/b", 2)]);
    const logged = errors.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain('2 exact matches for "Lee Fields"');
    expect(logged).toContain("u/b (2 followers)");
  });
});

describe("spotifyEntry", () => {
  it("repeats the first act at the top level, or is null", () => {
    const first = { spotify_url: url("a"), matched_text: "A" };
    const second = { spotify_url: url("b"), matched_text: "B" };
    expect(spotifyEntry([first, second])).toEqual({ ...first, artists: [first, second] });
    expect(spotifyEntry([])).toBeNull();
  });
});

describe("_spotify.json", () => {
  it("sorts keys at every level like Python's sort_keys, without ASCII escaping", () => {
    const entry = { spotify_url: "u", matched_text: "Café", artists: [{ spotify_url: "u", matched_text: "Café" }] };
    expect(formatSpotifyJson({ "b act": entry, "A act": null })).toBe(
      [
        "{",
        '  "A act": null,',
        '  "b act": {',
        '    "artists": [',
        "      {",
        '        "matched_text": "Café",',
        '        "spotify_url": "u"',
        "      }",
        "    ],",
        '    "matched_text": "Café",',
        '    "spotify_url": "u"',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("writes {} with no music events, without needing credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spotify-lookup-"));
    writeFileSync(join(dir, "_selections.json"), JSON.stringify({ days: [day([], [{ title: "A Film", category: FILM }])] }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await lookupWeek({ weekDir: dir })).toBe(0);
    expect(readFileSync(join(dir, "_spotify.json"), "utf8")).toBe("{}");
    vi.restoreAllMocks();
  });

  it("looks up every music title and writes the results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spotify-lookup-"));
    writeFileSync(
      join(dir, "_selections.json"),
      JSON.stringify({ days: [day([{ title: "Quicksand + Bane", is_music: true }], [{ title: "Nobody Known", category: MUSIC }])] }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const search = fakeSearch({ Quicksand: [artist("Quicksand", url("Quicksand"))], Bane: [artist("Bane", url("Bane"))] });
    expect(await lookupWeek({ weekDir: dir, search })).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, "_spotify.json"), "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      "Nobody Known": null,
      "Quicksand + Bane": {
        artists: [
          { matched_text: "Quicksand", spotify_url: url("Quicksand") },
          { matched_text: "Bane", spotify_url: url("Bane") },
        ],
        matched_text: "Quicksand",
        spotify_url: url("Quicksand"),
      },
    });
    vi.restoreAllMocks();
  });
});
