/**
 * Port of tests/test_csv_log.py, case for case, then TS-only tests for the
 * real-week fuzzy matches and for each Python bug csvLog.ts fixes (its
 * "Divergences from the Python").
 *
 * csv_log.py is currently NOT wired into runner.sh (the attendance/picks-log
 * feedback loop is deferred); these tests exist so neither implementation
 * rots while shelved.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICKS_LOG_COLUMNS, loadSelections, loadSpotify } from "./common.js";
import {
  type SpotifyMap,
  appendRows,
  buildRows,
  findMatchingEvent,
  inferPriceTier,
  loadExistingKeys,
  run,
  titleSimilarity,
} from "./csvLog.js";
import type { Selections } from "./htmlRender.js";
import { PicksLogError, parsePicksLog, rowKey } from "./lib/picksLog.js";

const REPO_ROOT = join(import.meta.dirname, "..");

const tmpDirs: string[] = [];
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "csvlog-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readLog = (path: string): ReturnType<typeof parsePicksLog> => parsePicksLog(readFileSync(path, "utf8"), path);

// --- infer_price_tier ---
// Rules per the module docstring, validated against the real archived week
// (docs/v1/Data/event-picks-log.csv, 2026-06-22, 30 rows cross-checked).

describe("inferPriceTier", () => {
  it("sold out is always paid regardless of cost", () => {
    expect(inferPriceTier("free", true)).toBe("paid");
  });

  it("placeholder cost is blank, never guessed", () => {
    expect(inferPriceTier("*(confirm details)*")).toBe("");
  });

  it("free synonym", () => {
    expect(inferPriceTier("free")).toBe("free");
    expect(inferPriceTier("No Cover")).toBe("free");
  });

  it("dollar amount under 15 is low", () => {
    expect(inferPriceTier("$10")).toBe("low");
  });

  it("dollar amount 15 or over is paid", () => {
    expect(inferPriceTier("$15 adv / $20 DOS")).toBe("paid");
  });

  it("no dollar amount stated defaults to free", () => {
    // "anything else (no $ amount stated)" per the docstring -- e.g. a
    // store-donation ask with no fixed number.
    expect(inferPriceTier("donation to store requested")).toBe("free");
  });

  it("empty cost is blank", () => {
    expect(inferPriceTier("")).toBe("");
  });
});

// --- find_matching_event ---

const WILDWOOD_EVENT = {
  title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)",
  category: "🎬 Film & Cinema",
  source: "PhilaMOCA",
};

describe("findMatchingEvent", () => {
  it("exact title match", () => {
    const mention = { title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", venue: "PhilaMOCA" };
    expect(findMatchingEvent(mention, [WILDWOOD_EVENT])?.category).toBe("🎬 Film & Cinema");
  });

  it("falls back to fuzzy match above threshold", () => {
    // Selection sometimes writes the honorable-mention title slightly
    // differently than the day's events-array entry for the same event (a
    // "(SOLD OUT)" suffix added, a subtitle dropped) -- confirmed on the real
    // archived week.
    const mention = { title: "WILDWOOD, NJ (1994) — Cult Movie Monday", venue: "PhilaMOCA" };
    expect(findMatchingEvent(mention, [WILDWOOD_EVENT])?.category).toBe("🎬 Film & Cinema");
  });

  it("returns nothing below fuzzy threshold", () => {
    const mention = { title: "A Totally Different Event", venue: "Somewhere" };
    expect(findMatchingEvent(mention, [WILDWOOD_EVENT])).toBeUndefined();
  });

  it("returns nothing for no events", () => {
    expect(findMatchingEvent({ title: "Anything", venue: "Anywhere" }, [])).toBeUndefined();
  });
});

// --- build_rows ---

function selectionsWithOnePick(isMusic = false): Selections {
  return {
    days: [
      {
        day_name: "Monday",
        date: "2026-06-22",
        top3: [
          {
            rank: 1,
            title: "NFC Sculpture Workshop",
            venue: "Iffy Books",
            category: "💻 Tech & Maker",
            source: "Iffy Books",
            cost: "$4.50 kit",
            sold_out: false,
            is_music: isMusic,
          },
        ],
        honorable_mentions: [],
        events: [],
      },
    ],
    week: "2026-06-22",
  };
}

describe("buildRows", () => {
  it("maps category to the csv slug", () => {
    expect(buildRows(selectionsWithOnePick(), {})[0]!.category).toBe("tech");
  });

  it("top3 rank is stringified", () => {
    expect(buildRows(selectionsWithOnePick(), {})[0]!.rank).toBe("1");
  });

  it("non-music pick has no spotify link even if present", () => {
    const spotify = { "NFC Sculpture Workshop": { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "x" } };
    expect(buildRows(selectionsWithOnePick(false), spotify)[0]!.spotify_link).toBe("");
  });

  it("music pick includes its spotify link", () => {
    const spotify = { "NFC Sculpture Workshop": { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "x" } };
    expect(buildRows(selectionsWithOnePick(true), spotify)[0]!.spotify_link).toBe("https://open.spotify.com/artist/xyz");
  });

  it("tags and attended are always blank", () => {
    // Per the module docstring: no tag/theme data exists in _selections.json
    // to derive `tags` from deterministically, and `attended` is filled in
    // retrospectively by attendance_check.py, never guessed here.
    const rows = buildRows(selectionsWithOnePick(), {});
    expect(rows[0]!.tags).toBe("");
    expect(rows[0]!.attended).toBe("");
  });

  it("includes honorable mentions with HM rank", () => {
    const selections: Selections = {
      week: "2026-06-22",
      days: [
        {
          day_name: "Monday",
          date: "2026-06-22",
          top3: [],
          honorable_mentions: [{ title: "ROAR (1981) — After Hours Curated", venue: "Philadelphia Film Society" }],
          events: [
            {
              title: "ROAR (1981) — After Hours Curated",
              category: "🎬 Film & Cinema",
              source: "Philadelphia Film Society",
              cost: "free",
              sold_out: false,
            },
          ],
        },
      ],
    };
    const rows = buildRows(selections, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rank).toBe("HM");
    expect(rows[0]!.category).toBe("film");
  });
});

// --- load_existing_keys / append_rows ---

describe("loadExistingKeys / appendRows", () => {
  it("loadExistingKeys returns an empty set for a missing file", () => {
    expect(loadExistingKeys(join(tmpPath(), "does-not-exist.csv")).size).toBe(0);
  });

  it("appendRows writes a header on first write", () => {
    const path = join(tmpPath(), "log.csv");
    expect(appendRows(path, buildRows(selectionsWithOnePick(), {}))).toBe(1);
    expect(readFileSync(path, "utf8").split("\r\n")[0]).toBe(PICKS_LOG_COLUMNS.join(","));
    expect(readLog(path)).toHaveLength(1);
  });

  it("appendRows does not duplicate the header on a second write", () => {
    const path = join(tmpPath(), "log.csv");
    const rows = buildRows(selectionsWithOnePick(), {});
    appendRows(path, rows);
    appendRows(path, rows);
    // csvLog's own idempotency (existing-keys skip) is run()'s job, not appendRows'.
    expect(readLog(path)).toHaveLength(2);
  });

  it("loadExistingKeys reflects a previously appended row", () => {
    const path = join(tmpPath(), "log.csv");
    appendRows(path, buildRows(selectionsWithOnePick(), {}));
    expect(loadExistingKeys(path).has(rowKey({ week_of: "2026-06-22", title: "NFC Sculpture Workshop" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TS-only
// ---------------------------------------------------------------------------

describe("titleSimilarity", () => {
  it.each([
    ["WILDWOOD, NJ (1994) — Cult Movie Monday", "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", 12 / 14],
    ["Tommy Conwell & The Young Rumblers + fireworks", "Tommy Conwell & The Young Rumblers — Free Concert + Fireworks", 12 / 14],
    ["A Totally Different Event", "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", 0],
    ["Café Noir", "CAFÉ noir!", 1],
    ["", "", 0],
  ])("%j vs %j", (a, b, expected) => {
    expect(titleSimilarity(a, b)).toBeCloseTo(expected, 12);
  });
});

describe("real week 2026-06-22", () => {
  const weekDir = join(REPO_ROOT, "data", "2026-06-22");
  const rows = buildRows(loadSelections(weekDir) as Selections, loadSpotify(weekDir) as SpotifyMap);

  // The only two honorable mentions in data/ without an exact events[] title;
  // expected values are csv_log.py's output for the same week.
  it.each([
    ["WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", "film", "PhilaMOCA", "paid"],
    ["Tommy Conwell & The Young Rumblers + fireworks", "music", "WXPN", "free"],
  ])("fuzzy-matches %j", (title, category, source, price_tier) => {
    const row = rows.find((r) => r.title === title && r.rank === "HM");
    expect(row).toMatchObject({ category, source, price_tier });
  });

  it("round-trips through appendRows + loadExistingKeys", () => {
    const path = join(tmpPath(), "log.csv");
    appendRows(path, rows);
    expect(readLog(path)).toEqual(rows);
    const keys = loadExistingKeys(path);
    for (const row of rows) expect(keys.has(rowKey(row))).toBe(true);
  });
});

describe("loadExistingKeys on the v1 picks log", () => {
  it("reads quoted titles", () => {
    const keys = loadExistingKeys(join(REPO_ROOT, "docs", "v1", "Data", "event-picks-log.csv"));
    expect(keys.size).toBeGreaterThan(100);
  });
});

describe("fixed Python bugs", () => {
  it("an empty existing log gets a header", () => {
    const path = join(tmpPath(), "log.csv");
    writeFileSync(path, "");
    appendRows(path, buildRows(selectionsWithOnePick(), {}));
    expect(readLog(path).map((r) => r.title)).toEqual(["NFC Sculpture Workshop"]);
  });

  it("a log without a trailing newline doesn't get the first new row glued on", () => {
    const path = join(tmpPath(), "log.csv");
    appendRows(path, buildRows(selectionsWithOnePick(), {}));
    writeFileSync(path, readFileSync(path, "utf8").replace(/\r\n$/, ""));
    const second = buildRows(selectionsWithOnePick(), {}).map((r) => ({ ...r, title: "Second" }));
    appendRows(path, second);
    expect(readLog(path).map((r) => r.title)).toEqual(["NFC Sculpture Workshop", "Second"]);
  });

  it("a Spotify entry without spotify_url gives an empty link", () => {
    const spotify: SpotifyMap = { "NFC Sculpture Workshop": {} };
    expect(buildRows(selectionsWithOnePick(true), spotify)[0]!.spotify_link).toBe("");
    expect(buildRows(selectionsWithOnePick(true), { "NFC Sculpture Workshop": null })[0]!.spotify_link).toBe("");
  });

  it("honorable_mentions: null means none", () => {
    const selections = selectionsWithOnePick();
    (selections.days[0] as unknown as Record<string, unknown>)["honorable_mentions"] = null;
    expect(buildRows(selections, {})).toHaveLength(1);
  });

  it("text is UTF-8 and fields with , \" or newlines round-trip", () => {
    const path = join(tmpPath(), "log.csv");
    const titles = ["Café — “Noir”", 'He said "hi", twice', "two\nlines", "carriage\rreturn"];
    const rows = titles.map((title) => ({ ...buildRows(selectionsWithOnePick(), {})[0]!, title }));
    appendRows(path, rows);
    expect(readFileSync(path).includes(Buffer.from("Café — “Noir”", "utf8"))).toBe(true);
    expect(readLog(path).map((r) => r.title)).toEqual(titles);
  });
});

describe("run", () => {
  let dir: string;
  let logPath: string;
  let weekDir: string;

  function writeWeek(selections: Selections): void {
    writeFileSync(join(weekDir, "_selections.json"), JSON.stringify(selections));
  }

  beforeEach(() => {
    dir = tmpPath();
    logPath = join(dir, "log.csv");
    weekDir = dir;
    vi.stubEnv("PICKS_LOG_PATH", logPath);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is idempotent across runs", () => {
    writeWeek(selectionsWithOnePick());
    expect(run({ weekDir, dryRun: false })).toEqual({ appended: 1, skipped: 0 });
    expect(run({ weekDir, dryRun: false })).toEqual({ appended: 0, skipped: 1 });
    expect(readLog(logPath)).toHaveLength(1);
  });

  it("writes a (week_of, title) repeated within one week once", () => {
    const selections = selectionsWithOnePick();
    const day = selections.days[0]!;
    day.honorable_mentions = [{ title: "NFC Sculpture Workshop", venue: "Iffy Books" }];
    writeWeek(selections);
    expect(run({ weekDir, dryRun: false })).toEqual({ appended: 1, skipped: 1 });
    expect(readLog(logPath).map((r) => r.rank)).toEqual(["1"]);
  });

  it("--dry-run writes nothing", () => {
    writeWeek(selectionsWithOnePick());
    expect(run({ weekDir, dryRun: true })).toEqual({ appended: 0, skipped: 0 });
    expect(() => readFileSync(logPath)).toThrow();
  });

  it("refuses to append to a log with the wrong header, leaving it untouched", () => {
    writeWeek(selectionsWithOnePick());
    const original = "city,week_of,title\r\nPhiladelphia,2026-06-15,A\r\n";
    writeFileSync(logPath, original);
    expect(() => run({ weekDir, dryRun: false })).toThrow(PicksLogError);
    expect(readFileSync(logPath, "utf8")).toBe(original);
  });
});
