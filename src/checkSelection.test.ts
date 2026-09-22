/**
 * Ported from tests/test_check_selection.py, plus a handful of new cases for
 * this port's own divergences (pyRepr's quote-switching, the non-string
 * `time` FAIL instead of a Python TypeError crash) -- see checkSelection.ts's
 * module docstring. All fixtures are small inline objects shaped like a
 * merged _selections.json, following mergeSelections.test.ts's precedent of
 * not needing disk I/O to exercise pure transform logic; loadRecentWeeks is
 * the one function here that does touch disk, and keeps its own describe
 * block below.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Issue,
  type ListedEvent,
  type Pick,
  type Selections,
  type SelectionsDay,
  checkAddressConflict,
  checkCostNotBlank,
  checkImplausibleStartTime,
  checkMissingAddress,
  checkOutsidePhiladelphia,
  checkRepeatOfRecentPick,
  checkSameSeries,
  checkTimeFormat,
  checkVenueCap,
  collectIssues,
  formatReport,
  loadRecentWeeks,
  normalizeVenue,
  summarize,
  venueKey,
} from "./checkSelection.js";
import { writeJson } from "./lib/json.js";

const MUSIC = "🎵 Music & Concerts";

function pick(
  title: string,
  opts: {
    venue?: string;
    address?: string;
    time?: unknown;
    cost?: string;
    category?: string;
    source?: string;
    venue_address?: string;
    selection_address?: string;
    venue_id?: string;
  } = {},
): Pick {
  const p: Pick = {
    title,
    venue: opts.venue ?? "Some Venue",
    time: opts.time ?? "7:00 PM",
    cost: opts.cost ?? "$10",
    category: opts.category ?? MUSIC,
    source: opts.source ?? "Some Source",
  };
  if (opts.address) p.address = opts.address;
  if (opts.venue_address) p.venue_address = opts.venue_address;
  if (opts.selection_address) p.selection_address = opts.selection_address;
  if (opts.venue_id) p.venue_id = opts.venue_id;
  return p;
}

function day(date: string, opts: { top3?: Pick[]; events?: ListedEvent[] } = {}): SelectionsDay {
  return { date, day_name: "Monday", top3: opts.top3 ?? [], honorable_mentions: [], events: opts.events ?? [] };
}

function selections(days: SelectionsDay[], week = "2026-08-03"): Selections {
  return { week, days };
}

// --- venue cap ---

describe("checkVenueCap", () => {
  it("is not tripped at exactly the cap", () => {
    const picks = [pick("A", { address: "123 Chestnut St" }), pick("B", { address: "123 Chestnut St" })];
    expect(checkVenueCap(selections([day("2026-08-03", { top3: picks })]))).toEqual([]);
  });

  it("is tripped over the cap", () => {
    const picks = [
      pick("A", { address: "123 Chestnut St" }),
      pick("B", { address: "123 Chestnut St" }),
      pick("C", { address: "123 Chestnut St" }),
    ];
    const issues = checkVenueCap(selections([day("2026-08-03", { top3: picks })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
    expect(issues[0]!.message).toContain("123chestnutst");
  });

  it("collapses punctuation variants of the same address", () => {
    const picks = [
      pick("A", { address: "404 S. 20th St., Philadelphia, PA 19146" }),
      pick("B", { address: "404 S. 20th St, Philadelphia, PA 19146" }),
      pick("C", { address: "404 S 20th St, Philadelphia, PA 19146" }),
    ];
    expect(checkVenueCap(selections([day("2026-08-03", { top3: picks })]))).toHaveLength(1);
  });

  it("counts across the whole week, not per day", () => {
    const days = [
      day("2026-08-03", { top3: [pick("A", { address: "123 Chestnut St" })] }),
      day("2026-08-04", { top3: [pick("B", { address: "123 Chestnut St" })] }),
      day("2026-08-05", { top3: [pick("C", { address: "123 Chestnut St" })] }),
    ];
    expect(checkVenueCap(selections(days))).toHaveLength(1);
  });

  it("falls back to normalized venue when address is missing", () => {
    const picks = [
      pick("A", { venue: "Iffy Books, 404 S. 20th St., Philadelphia, 19146, United States" }),
      pick("B", { venue: "Iffy Books" }),
      pick("C", { venue: "Iffy Books" }),
    ];
    const issues = checkVenueCap(selections([day("2026-08-03", { top3: picks })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("iffybooks");
  });

  it("reprs each pick's title with pyRepr's quote-switching for an apostrophe", () => {
    const picks = [
      pick("Johnny Brenda's Presents: A", { address: "847 N 3rd St" }),
      pick("Johnny Brenda's Presents: B", { address: "847 N 3rd St" }),
      pick("Johnny Brenda's Presents: C", { address: "847 N 3rd St" }),
    ];
    const issues = checkVenueCap(selections([day("2026-08-03", { top3: picks })]));
    expect(issues).toHaveLength(1);
    // Python repr("Johnny Brenda's Presents: A") switches to double quotes; a
    // naive single-quote wrap or unescaped JSON.stringify would diverge here.
    expect(issues[0]!.message).toContain(`"Johnny Brenda's Presents: A"`);
  });
});

describe("normalizeVenue", () => {
  it("strips the address suffix and lowercases", () => {
    expect(normalizeVenue("Ortlieb's, Philadelphia, PA")).toBe("ortlieb's");
    expect(normalizeVenue("Ortlieb's")).toBe("ortlieb's");
  });
});

// --- time format ---

describe("checkTimeFormat", () => {
  it("accepts a clean single time", () => {
    expect(checkTimeFormat(selections([day("2026-08-03", { top3: [pick("A", { time: "7:00 PM" })] })]))).toEqual([]);
  });

  it("rejects a range", () => {
    const issues = checkTimeFormat(selections([day("2026-08-03", { top3: [pick("A", { time: "7:00, 7:30" })] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("fail");
  });

  it("rejects a doors/show pair", () => {
    const s = selections([day("2026-08-03", { top3: [pick("A", { time: "6:00 PM (doors), 7:00 PM (show)" })] })]);
    expect(checkTimeFormat(s)).toHaveLength(1);
  });

  it("reports a non-string time as a clean FAIL instead of crashing (Python raises an uncaught TypeError here)", () => {
    const issues = checkTimeFormat(selections([day("2026-08-03", { top3: [pick("A", { time: ["7:00 PM"] })] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("fail");
    expect(issues[0]!.message).toContain('["7:00 PM"]');
  });
});

// --- cost not blank ---

describe("checkCostNotBlank", () => {
  it("passes when cost is present", () => {
    expect(checkCostNotBlank(selections([day("2026-08-03", { top3: [pick("A", { cost: "Not listed" })] })]))).toEqual([]);
  });

  it("fails on an empty top3 cost", () => {
    const issues = checkCostNotBlank(selections([day("2026-08-03", { top3: [pick("A", { cost: "" })] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("fail");
  });

  it("fails on an empty listed-event cost", () => {
    const issues = checkCostNotBlank(selections([day("2026-08-03", { events: [{ title: "A", cost: "" }] })]));
    expect(issues).toHaveLength(1);
  });

  it("reports a missing day date as null, not '?' (the iterTop3 default) -- preserves the asymmetry from Python's day.get('date')", () => {
    const issues = checkCostNotBlank(selections([{ day_name: "Monday", top3: [pick("A", { cost: "" })], events: [] }]));
    expect(issues[0]!.day).toBeNull();
  });
});

// --- implausible start time ---

describe("checkImplausibleStartTime", () => {
  it("flags midnight as warn", () => {
    const issues = checkImplausibleStartTime(selections([day("2026-08-03", { top3: [pick("A", { time: "12:00 AM" })] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
  });

  it("does not flag a normal evening time", () => {
    expect(checkImplausibleStartTime(selections([day("2026-08-03", { top3: [pick("A", { time: "7:00 PM" })] })]))).toEqual([]);
  });

  it("does not flag noon (12:00 PM), unlike midnight", () => {
    expect(checkImplausibleStartTime(selections([day("2026-08-03", { top3: [pick("A", { time: "12:00 PM" })] })]))).toEqual([]);
  });

  it("skips an already-malformed time -- checkTimeFormat already flags this", () => {
    expect(checkImplausibleStartTime(selections([day("2026-08-03", { top3: [pick("A", { time: "7:00, 7:30" })] })]))).toEqual([]);
  });

  it("skips a non-string time without throwing", () => {
    expect(checkImplausibleStartTime(selections([day("2026-08-03", { top3: [pick("A", { time: ["7:00 PM"] })] })]))).toEqual([]);
  });
});

// --- same series ---

describe("checkSameSeries", () => {
  it("flags a shared prefix at the same venue", () => {
    const picks = [
      pick("Beginner Soldering: Li-Ion Battery Pack", { venue: "Iffy Books" }),
      pick("Beginner Soldering: LED Spinning Top", { venue: "Iffy Books" }),
    ];
    const s = selections([day("2026-08-03", { top3: [picks[0]!] }), day("2026-08-04", { top3: [picks[1]!] })]);
    const issues = checkSameSeries(s);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
  });

  it("does not flag different venues with the same prefix", () => {
    const picks = [pick("Workshop: Part One", { venue: "Iffy Books" }), pick("Workshop: Part Two", { venue: "Wooden Shoe Books" })];
    expect(checkSameSeries(selections([day("2026-08-03", { top3: picks })]))).toEqual([]);
  });

  it("ignores titles with no separator", () => {
    const picks = [pick("Palinoia"), pick("Palinoia Reunion")];
    expect(checkSameSeries(selections([day("2026-08-03", { top3: picks })]))).toEqual([]);
  });
});

// --- outside philadelphia ---

describe("checkOutsidePhiladelphia", () => {
  it("flags a different municipality", () => {
    const s = selections([day("2026-08-10", { top3: [pick("A", { address: "100 Station Ave, Oaks, PA 19456" })] })]);
    const issues = checkOutsidePhiladelphia(s);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
  });

  it("does not flag a Philadelphia address", () => {
    const s = selections([day("2026-08-10", { top3: [pick("A", { address: "531 N 12th St, Philadelphia, PA 19123" })] })]);
    expect(checkOutsidePhiladelphia(s)).toEqual([]);
  });

  it("skips a pick with no address", () => {
    const s = selections([day("2026-08-03", { top3: [pick("A", { venue: "The Dell Music Center" })] })]);
    expect(checkOutsidePhiladelphia(s)).toEqual([]);
  });
});

// --- repeat of a recent pick ---

describe("checkRepeatOfRecentPick", () => {
  it("flags the same event in a prior week", () => {
    const prior = selections(
      [day("2026-08-10", { top3: [pick("Killer Of Sheep", { venue: "Philadelphia Film Society" })] })],
      "2026-08-10",
    );
    const current = selections(
      [day("2026-08-20", { top3: [pick("Killer Of Sheep", { venue: "Philadelphia Film Society" })] })],
      "2026-08-17",
    );
    const issues = checkRepeatOfRecentPick(current, [prior]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
    expect(issues[0]!.message).toContain("2026-08-10");
  });

  it("matches across an inconsistent model-written address", () => {
    const prior = selections(
      [
        day("2026-08-12", {
          top3: [
            pick("West Philly Canvass", {
              venue: "Kingsessing Recreation Center",
              address: "5140 Chester Ave, Philadelphia, PA 19143",
            }),
          ],
        }),
      ],
      "2026-08-10",
    );
    const current = selections(
      [
        day("2026-08-19", {
          top3: [
            pick("West Philly Canvass", {
              venue: "Kingsessing Recreation Center",
              address: "4901 Kingsessing Ave, Philadelphia, PA 19143",
            }),
          ],
        }),
      ],
      "2026-08-17",
    );
    expect(checkRepeatOfRecentPick(current, [prior])).toHaveLength(1);
  });

  it("normalizes an emoji-prefixed title", () => {
    const prior = selections(
      [day("2026-08-06", { top3: [pick("Beginner Soldering: Li-Ion Battery Pack", { venue: "Iffy Books" })] })],
      "2026-08-03",
    );
    const current = selections(
      [day("2026-08-20", { top3: [pick("\u{1F50B} Beginner Soldering: Li-Ion Battery Pack", { venue: "Iffy Books" })] })],
      "2026-08-17",
    );
    expect(checkRepeatOfRecentPick(current, [prior])).toHaveLength(1);
  });

  it("does not flag the same title at a different venue", () => {
    const prior = selections([day("2026-08-10", { top3: [pick("Open Mic", { venue: "Tattooed Mom" })] })], "2026-08-10");
    const current = selections([day("2026-08-17", { top3: [pick("Open Mic", { venue: "Ortlieb's" })] })], "2026-08-17");
    expect(checkRepeatOfRecentPick(current, [prior])).toEqual([]);
  });

  it("does not flag a new instalment of a series", () => {
    const prior = selections(
      [day("2026-08-12", { top3: [pick("Dekalog: Parts 1 & 2", { venue: "Philadelphia Film Society" })] })],
      "2026-08-10",
    );
    const current = selections(
      [day("2026-08-19", { top3: [pick("Dekalog: Parts 3 & 4", { venue: "Philadelphia Film Society" })] })],
      "2026-08-17",
    );
    expect(checkRepeatOfRecentPick(current, [prior])).toEqual([]);
  });

  it("reports every prior week it appeared in", () => {
    const priors = [
      selections([day("2026-08-04", { top3: [pick("Reading Group", { venue: "Ethical Society" })] })], "2026-08-03"),
      selections([day("2026-08-11", { top3: [pick("Reading Group", { venue: "Ethical Society" })] })], "2026-08-10"),
    ];
    const current = selections([day("2026-08-18", { top3: [pick("Reading Group", { venue: "Ethical Society" })] })], "2026-08-17");
    const issues = checkRepeatOfRecentPick(current, priors);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("2026-08-03");
    expect(issues[0]!.message).toContain("2026-08-10");
  });

  it("is silent with no prior weeks", () => {
    const current = selections([day("2026-08-17", { top3: [pick("Anything")] })]);
    expect(checkRepeatOfRecentPick(current, [])).toEqual([]);
    expect(checkRepeatOfRecentPick(current, null)).toEqual([]);
    expect(checkRepeatOfRecentPick(current)).toEqual([]);
  });
});

// --- load_recent_weeks (the one check that touches disk) ---

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "twip-check-selection-"));
}

function weekOnDisk(root: string, name: string, { withSelections = true } = {}): void {
  const dir = join(root, name);
  mkdirSync(dir);
  if (withSelections) {
    const days = [{ date: name, day_name: "Monday", top3: [], honorable_mentions: [], events: [] }];
    writeFileSync(join(dir, "_selections.json"), writeJson({ week: name, days }));
  }
}

describe("loadRecentWeeks", () => {
  it("returns the most recent priors, newest first", () => {
    const root = makeTmpDir();
    for (const name of ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]) {
      weekOnDisk(root, name);
    }
    const weeks = loadRecentWeeks(join(root, "2026-08-24"), 2) as { week: string }[];
    expect(weeks.map((w) => w.week)).toEqual(["2026-08-17", "2026-08-10"]);
  });

  it("skips Collection-only weeks (no _selections.json)", () => {
    const root = makeTmpDir();
    weekOnDisk(root, "2026-07-13");
    weekOnDisk(root, "2026-07-20", { withSelections: false });
    weekOnDisk(root, "2026-07-27", { withSelections: false });
    weekOnDisk(root, "2026-08-03");
    const weeks = loadRecentWeeks(join(root, "2026-08-03"), 3) as { week: string }[];
    expect(weeks.map((w) => w.week)).toEqual(["2026-07-13"]);
  });

  it("returns empty for the earliest week", () => {
    const root = makeTmpDir();
    weekOnDisk(root, "2026-06-22");
    expect(loadRecentWeeks(join(root, "2026-06-22"))).toEqual([]);
  });

  it("never looks forward", () => {
    const root = makeTmpDir();
    weekOnDisk(root, "2026-08-17");
    weekOnDisk(root, "2026-08-24");
    expect(loadRecentWeeks(join(root, "2026-08-17"))).toEqual([]);
  });
});

// --- collect_issues ---

describe("collectIssues", () => {
  it("omits the repeat check when no priors are passed", () => {
    const s = selections([day("2026-08-17", { top3: [pick("A")] })]);
    const checks = new Set(collectIssues(s).map((i: Issue) => i.check));
    expect(checks.has("repeat_pick")).toBe(false);
  });

  it("includes the repeat check when priors are passed", () => {
    const prior = selections([day("2026-08-10", { top3: [pick("A")] })], "2026-08-10");
    const s = selections([day("2026-08-17", { top3: [pick("A")] })]);
    const checks = new Set(collectIssues(s, [prior]).map((i: Issue) => i.check));
    expect(checks.has("repeat_pick")).toBe(true);
  });

  it("aggregates all checks", () => {
    const picks = [pick("A", { address: "123 Chestnut St", time: "7:00, 7:30", cost: "" })];
    const issues = collectIssues(selections([day("2026-08-03", { top3: picks })]));
    const checks = new Set(issues.map((i: Issue) => i.check));
    expect(checks.has("time_format")).toBe(true);
    expect(checks.has("cost_blank")).toBe(true);
    // implausible_time is suppressed because time_format already caught this malformed time.
    expect(checks.has("implausible_time")).toBe(false);
  });
});

// --- venue key: abbreviation/ZIP folding, source precedence, degenerate keys ---

describe("venueKey", () => {
  it("folds abbreviation variants of one address", () => {
    const pairs: [string, string][] = [
      ["1412 Chestnut St, Philadelphia, PA 19102", "1412 Chestnut Street, Philadelphia, PA 19102"],
      ["847 N 3rd St, Philadelphia, PA 19123", "847 North 3rd Street, Philadelphia, PA 19123"],
      ["1201 N Frankford Ave, Philadelphia, PA 19125", "1201 North Frankford Ave, Philadelphia, PA 19125"],
    ];
    for (const [a, b] of pairs) {
      expect(venueKey({ address: a })).toBe(venueKey({ address: b }));
    }
  });

  it("folds ZIP drift on one address", () => {
    expect(venueKey({ address: "1200 Callowhill St, Philadelphia, PA 19107" })).toBe(
      venueKey({ address: "1200 Callowhill St, Philadelphia, PA 19123" }),
    );
    expect(venueKey({ address: "5001 Market St, Philadelphia, PA" })).toBe(
      venueKey({ address: "5001 Market St, Philadelphia, PA 19139" }),
    );
  });

  it("keeps the same house number on a different street distinct", () => {
    expect(venueKey({ address: "847 N 3rd St, Philadelphia, PA 19123" })).not.toBe(
      venueKey({ address: "847 N Franklin St, Philadelphia, PA 19123" }),
    );
  });

  it("is comparable across sources (source venue_address vs Selection's fuller address)", () => {
    expect(venueKey({ venue_address: "531 N 12th St" })).toBe(venueKey({ address: "531 N 12th St, Philadelphia, PA 19123" }));
  });

  it("prefers the source address and splits the false merge", () => {
    const spruce: Pick = { venue: "Spruce Street Harbor", address: "301 S Christopher Columbus Blvd, Philadelphia, PA 19106" };
    const cherry: Pick = {
      venue: "Cherry Street Pier",
      address: "301 S Christopher Columbus Blvd, Philadelphia, PA 19106",
      venue_address: "121 N Christopher Columbus Blvd, Philadelphia, PA 19106",
    };
    expect(venueKey(spruce)).toBe("301schristophercolumbusblvd");
    expect(venueKey(cherry)).toBe("121nchristophercolumbusblvd");
    expect(venueKey(spruce)).not.toBe(venueKey(cherry));
  });

  it("falls back to the venue name without any address", () => {
    expect(venueKey({ venue: "Pentridge Station" })).toBe(venueKey({ venue: "Pentridge Station, Philadelphia, PA" }));
  });
});

// --- missing address / address conflict ---

describe("checkMissingAddress", () => {
  it("flags a pick with no address from either side", () => {
    const issues = checkMissingAddress(selections([day("2026-08-03", { top3: [pick("A")] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
    expect(issues[0]!.message).toContain("no location");
  });

  it("is quiet when the merge backfilled an address", () => {
    const picks = [pick("A", { address: "304 South St, Philadelphia, PA 19147" })];
    expect(checkMissingAddress(selections([day("2026-08-03", { top3: picks })]))).toEqual([]);
  });
});

describe("checkAddressConflict", () => {
  it("flags a real disagreement", () => {
    const p = pick("Sheer Mag", {
      address: "121 N Christopher Columbus Blvd",
      venue_address: "121 N Christopher Columbus Blvd",
      selection_address: "301 S Christopher Columbus Blvd",
    });
    const issues = checkAddressConflict(selections([day("2026-08-03", { top3: [p] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warn");
  });

  it("ignores mere spelling differences", () => {
    const p = pick("Show", {
      address: "1412 Chestnut St",
      venue_address: "1412 Chestnut St, Philadelphia, PA 19102",
      selection_address: "1412 Chestnut Street, Philadelphia, PA 19102",
    });
    expect(checkAddressConflict(selections([day("2026-08-03", { top3: [p] })]))).toEqual([]);
  });
});

// --- formatReport / summarize ---

describe("formatReport", () => {
  it("pyRepr's issue.title switches to double quotes for a single-quoted title", () => {
    const issues: Issue[] = [
      { check: "cost_blank", severity: "fail", day: "2026-08-03", title: "Johnny Brenda's Presents", message: "blank cost" },
    ];
    const report = formatReport(issues, "2026-08-03");
    expect(report).toContain(`"Johnny Brenda's Presents"`);
  });

  it("reports no issues found and a zero/zero tally", () => {
    const report = formatReport([], "2026-08-03");
    expect(report).toContain("no issues found");
    expect(report).toContain("0 fail(s), 0 warn(s).");
  });
});

describe("summarize", () => {
  it("sorts counts descending, ties keeping first-seen order (no alphabetical tiebreak)", () => {
    const picks = [
      pick("A", { venue: "Zebra Room", address: "1 A St" }),
      pick("B", { venue: "Apple Room", address: "2 B St" }),
    ];
    const s = summarize(selections([day("2026-08-03", { top3: picks })]));
    const venueLine = s.split("\n")[0]!;
    // Both venues tie at 1 -- first-seen (Zebra before Apple) must survive, not alphabetical.
    expect(venueLine.indexOf("1ast")).toBeLessThan(venueLine.indexOf("2bst"));
  });

  it("reports (none) for an empty week", () => {
    const s = summarize(selections([day("2026-08-03")]));
    expect(s).toBe("top3 by venue: (none)\ntop3 by category: (none)\ntop3 by source: (none)");
  });
});
