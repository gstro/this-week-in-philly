/**
 * Port of tests/test_csv_log.py, case for case, plus a TS-only block at the
 * end pinning the Python-semantics pieces csvLog.ts reimplements by hand:
 * difflib.SequenceMatcher ratios and csv-module bytes, each expected value
 * taken from CPython 3.12 (.venv) rather than reasoned out.
 *
 * csv_log.py is currently NOT wired into runner.sh (the attendance/picks-log
 * feedback loop is deferred); these tests exist so neither implementation
 * rots while shelved.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSelections, loadSpotify } from "./common.js";
import {
  type SpotifyMap,
  appendRows,
  buildRows,
  findMatchingEvent,
  formatCsvRow,
  inferPriceTier,
  loadExistingKeys,
  logKey,
  parseCsv,
  parseCsvDicts,
  sequenceMatcherRatio,
} from "./csvLog.js";
import type { Selections } from "./htmlRender.js";

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

describe("findMatchingEvent", () => {
  it("exact title match", () => {
    const mention = { title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", venue: "PhilaMOCA" };
    const events = [
      { title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", category: "🎬 Film & Cinema", source: "PhilaMOCA" },
    ];
    expect(findMatchingEvent(mention, events).category).toBe("🎬 Film & Cinema");
  });

  it("falls back to fuzzy match above threshold", () => {
    // Selection sometimes writes the honorable-mention title slightly
    // differently than the day's events-array entry for the same event (a
    // "(SOLD OUT)" suffix added, a subtitle dropped) -- confirmed on the real
    // archived week.
    const mention = { title: "WILDWOOD, NJ (1994) — Cult Movie Monday", venue: "PhilaMOCA" };
    const events = [
      { title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", category: "🎬 Film & Cinema", source: "PhilaMOCA" },
    ];
    expect(findMatchingEvent(mention, events).category).toBe("🎬 Film & Cinema");
  });

  it("returns empty object below fuzzy threshold", () => {
    const mention = { title: "A Totally Different Event", venue: "Somewhere" };
    const events = [
      { title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", category: "🎬 Film & Cinema", source: "PhilaMOCA" },
    ];
    expect(findMatchingEvent(mention, events)).toEqual({});
  });

  it("returns empty object for no events", () => {
    expect(findMatchingEvent({ title: "Anything", venue: "Anywhere" }, [])).toEqual({});
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
    const rows = buildRows(selectionsWithOnePick(), {});
    expect(rows[0]!.category).toBe("tech");
  });

  it("top3 rank is stringified", () => {
    const rows = buildRows(selectionsWithOnePick(), {});
    expect(rows[0]!.rank).toBe("1");
  });

  it("non-music pick has no spotify link even if present", () => {
    const spotify = { "NFC Sculpture Workshop": { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "x" } };
    const rows = buildRows(selectionsWithOnePick(false), spotify);
    expect(rows[0]!.spotify_link).toBe("");
  });

  it("music pick includes its spotify link", () => {
    const spotify = { "NFC Sculpture Workshop": { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "x" } };
    const rows = buildRows(selectionsWithOnePick(true), spotify);
    expect(rows[0]!.spotify_link).toBe("https://open.spotify.com/artist/xyz");
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
    const rows = buildRows(selectionsWithOnePick(), {});
    const written = appendRows(path, rows);
    expect(written).toBe(1);
    const records = parseCsv(readFileSync(path, "utf8"));
    expect(records[0]).toContain("city");
    expect(records.slice(1)).toHaveLength(1);
  });

  it("appendRows does not duplicate the header on a second write", () => {
    const path = join(tmpPath(), "log.csv");
    const rows = buildRows(selectionsWithOnePick(), {});
    appendRows(path, rows);
    appendRows(path, rows);
    // csvLog's own idempotency (existing-keys skip) is main()'s job, not appendRows'.
    expect(parseCsvDicts(readFileSync(path, "utf8"))).toHaveLength(2);
  });

  it("loadExistingKeys reflects a previously appended row", () => {
    const path = join(tmpPath(), "log.csv");
    appendRows(path, buildRows(selectionsWithOnePick(), {}));
    expect(loadExistingKeys(path).has(logKey("2026-06-22", "NFC Sculpture Workshop"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TS-only: Python-semantics pins (expected values from CPython 3.12)
// ---------------------------------------------------------------------------

describe("sequenceMatcherRatio (difflib.SequenceMatcher(None, a, b).ratio())", () => {
  it.each([
    ["wildwood, nj (1994) — cult movie monday", "wildwood, nj (1994) — cult movie monday (sold out)", 0.8764044943820225],
    ["tommy conwell & the young rumblers + fireworks", "tommy conwell & the young rumblers", 0.85],
    ["a totally different event", "wildwood, nj (1994) — cult movie monday (sold out)", 0.13333333333333333],
    ["", "", 1.0],
    ["abc", "", 0.0],
    // Code points, not UTF-16 units: each emoji counts once.
    ["😀a😀b", "😀ab", 0.8571428571428571],
  ])("%j vs %j", (a, b, expected) => {
    expect(sequenceMatcherRatio(a, b)).toBe(expected);
  });

  it("applies autojunk's popular-element purge when len(b) >= 200", () => {
    // Every element of b occurs > len(b)//100 + 1 times, so all are purged
    // and nothing matches -- 1.0 without autojunk.
    expect(sequenceMatcherRatio("ab".repeat(150), "ba".repeat(150) + "x".repeat(20))).toBe(0.0);
  });
});

describe("csv module byte parity", () => {
  it("formatCsvRow quotes only on , \" \\r \\n and writes None as empty", () => {
    expect(formatCsvRow(["a b", " lead", "", null, "x,y", 'q"q', "l\rm", "n\nm", "é—", true, 7])).toBe(
      'a b, lead,,,"x,y","q""q","l\rm","n\nm",é—,True,7\r\n',
    );
  });

  it("parseCsv mirrors the non-strict reader's leniencies", () => {
    expect(parseCsv('a,"b"c,d"e","un\nterm')).toEqual([["a", "bc", 'd"e"', "un\nterm"]]);
    expect(parseCsv('x,"y\n')).toEqual([["x", "y\n"]]);
  });

  it("parseCsvDicts skips blank rows, pads short rows with None, collects extras under None", () => {
    const rows = parseCsvDicts("a,b\r\n\r\n1\r\n1,2,3\r\n,\r\n").map((m) => Object.fromEntries(m) as Record<string, unknown>);
    expect(rows).toEqual([{ a: "1", b: null }, { a: "1", b: "2", null: ["3"] }, { a: "", b: "" }]);
  });

  it("loadExistingKeys reads quoted titles from the v1 picks log", () => {
    const keys = loadExistingKeys(join(REPO_ROOT, "docs", "v1", "Data", "event-picks-log.csv"));
    expect(keys.size).toBeGreaterThan(100);
  });

  it("a real week round-trips through append + loadExistingKeys", () => {
    const weekDir = join(REPO_ROOT, "data", "2026-06-22");
    const rows = buildRows(loadSelections(weekDir) as Selections, loadSpotify(weekDir) as SpotifyMap);
    const path = join(tmpPath(), "log.csv");
    appendRows(path, rows);
    const keys = loadExistingKeys(path);
    for (const row of rows) expect(keys.has(logKey(row.week_of, row.title))).toBe(true);
  });

  it("an empty existing log gets no header (mirrors the Python)", () => {
    const path = join(tmpPath(), "log.csv");
    writeFileSync(path, "");
    appendRows(path, buildRows(selectionsWithOnePick(), {}));
    expect(readFileSync(path, "utf8").startsWith("Philadelphia,")).toBe(true);
  });
});
