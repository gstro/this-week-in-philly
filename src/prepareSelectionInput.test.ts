import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  assignIds,
  buildCandidates,
  buildRecentPicks,
  capDescriptions,
  collapseCrossSourceDuplicates,
  collapseExactDuplicates,
  collectionFailures,
  groupRecurring,
  loadCandidatesFromSources,
  loadManifest,
  normalizeTitle,
  priorityRank,
  splitByDay,
} from "./prepareSelectionInput.js";

// Points at the same fixture the Python suite uses -- see that fixture's
// own comment for why it's synthetic rather than a real archived week.
const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures", "prepare_selection_input");
const SAMPLE_WEEK = join(FIXTURES, "sample-week");

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "twip-prepare-selection-input-"));
}

function event(title: string, venue: string, date: string, overrides: Partial<Candidate> = {}): Candidate {
  return { title, venue, date, time: "", cost: "", url: "", description: "", ...overrides };
}

describe("sample week end-to-end regression", () => {
  it("reconciles every raw event", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    const recurring = result.candidates.filter((c) => c.recurrence_count);
    const passthrough = result.candidates.length - recurring.length;
    const consumed = recurring.reduce((sum, c) => sum + (c.recurrence_count ?? 0), 0);

    expect(result.raw_event_count).toBe(5); // 3 (do215-like) + 2 (other-source); failed-source contributes 0
    expect(passthrough + consumed).toBe(4);
    expect(
      passthrough + consumed + result.exact_duplicates_collapsed + result.cross_source_duplicates_collapsed,
    ).toBe(result.raw_event_count);
  });

  it("counts cross-source collapses separately from exact ones", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    expect(result.exact_duplicates_collapsed).toBe(1);
    expect(result.cross_source_duplicates_collapsed).toBe(0);
  });

  it("collapses the do215-shaped recurring listing", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    const recurring = result.candidates.filter((c) => c.recurrence_count);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]!.title).toBe("Museum Tour");
    expect(recurring[0]!.recurrence_count).toBe(3);
    expect(recurring[0]!.occurrences).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(recurring[0]!.date).toBe("2026-08-03"); // earliest occurrence is the representative
  });

  it("keeps the more complete exact duplicate", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    const concert = result.candidates.find((c) => c.title === "Concert Y")!;
    expect(concert.cost).toBe("$15"); // the complete entry, not the blank duplicate
  });

  it("reports the failed source", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    expect(result.collection_failures).toEqual(["failed-source (timeout)"]);
  });

  it("tags every candidate with its source", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    expect(new Set(result.candidates.map((c) => c.source))).toEqual(new Set(["Do215", "Some Other Source"]));
  });
});

describe("loadManifest / loadCandidatesFromSources", () => {
  it("reads the real shape", () => {
    const manifest = loadManifest(SAMPLE_WEEK);
    expect(manifest.week).toBe("2026-08-03");
    expect(manifest.sources?.["failed-source"]?.status).toBe("failed");
  });

  it("skips failed sources entirely", () => {
    const manifest = loadManifest(SAMPLE_WEEK);
    const events = loadCandidatesFromSources(SAMPLE_WEEK, manifest);
    expect(events.every((e) => e.source !== "failed-source")).toBe(true);
    expect(events).toHaveLength(5);
  });

  it("tags every event with the file-level source name", () => {
    // The real bug this exists to avoid: individual event dicts in a
    // source file don't carry a `source` field themselves -- only the
    // file's top-level `source` key does.
    const manifest = loadManifest(SAMPLE_WEEK);
    const events = loadCandidatesFromSources(SAMPLE_WEEK, manifest);
    const museumTours = events.filter((e) => e.title === "Museum Tour");
    expect(museumTours).toHaveLength(3);
    expect(museumTours.every((e) => e.source === "Do215")).toBe(true);
  });

  it("skips a manifest entry with no matching file", () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, "_manifest.json"),
      JSON.stringify({ week: "2026-08-03", sources: { "missing-source": { status: "ok", events: 1 } } }),
    );
    const manifest = loadManifest(dir);
    expect(loadCandidatesFromSources(dir, manifest)).toEqual([]);
  });
});

describe("collapseExactDuplicates", () => {
  it("passes a single entry through unchanged", () => {
    const events = [event("Solo Show", "Venue A", "2026-08-03", { source: "Luma" })];
    expect(collapseExactDuplicates(events)).toEqual(events);
  });

  it("prefers R5 over Do215", () => {
    const events = [
      event("Saetia", "First Unitarian Church", "2026-08-03", { source: "Do215", cost: "$15" }),
      event("Saetia", "First Unitarian Church", "2026-08-03", {
        source: "R5 Productions",
        cost: "$15 -- SOLD OUT confirmed",
      }),
    ];
    const result = collapseExactDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("R5 Productions");
  });

  it("prefers PhilaMOCA over Philly Ask A Punk", () => {
    const events = [
      event("Show", "PhilaMOCA", "2026-08-03", { source: "Philly Ask A Punk" }),
      event("Show", "PhilaMOCA", "2026-08-03", { source: "PhilaMOCA" }),
    ];
    expect(collapseExactDuplicates(events)[0]!.source).toBe("PhilaMOCA");
  });

  it("tiebreaks unlisted sources by completeness", () => {
    const events = [
      event("Concert Y", "Venue Z", "2026-08-03", { source: "Some Other Source", time: "7:00 PM", cost: "$15" }),
      event("Concert Y", "Venue Z", "2026-08-03", { source: "Another Unlisted Source" }),
    ];
    const result = collapseExactDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.cost).toBe("$15");
  });

  it("does not treat different dates as duplicates", () => {
    const events = [
      event("Show", "Venue", "2026-08-03", { source: "Luma" }),
      event("Show", "Venue", "2026-08-04", { source: "Luma" }),
    ];
    expect(collapseExactDuplicates(events)).toHaveLength(2);
  });

  it("preserves a sold-out signal from a discarded entry", () => {
    const events = [
      event("Show", "Venue", "2026-08-03", { source: "Do215", description: "A great show." }),
      event("Show", "Venue", "2026-08-03", { source: "Some Other Source", description: "This one is SOLD OUT." }),
    ];
    const result = collapseExactDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("Do215"); // priority winner unchanged
    expect(result[0]!.description!.toLowerCase()).toContain("sold out");
  });

  it("does not add a redundant sold-out note", () => {
    const events = [
      event("Show", "Venue", "2026-08-03", { source: "R5 Productions", description: "SOLD OUT already noted here." }),
      event("Show", "Venue", "2026-08-03", { source: "Do215", description: "Also sold out." }),
    ];
    const result = collapseExactDuplicates(events);
    expect(result[0]!.description!.split("[Note:").length - 1).toBe(0);
  });
});

// The safety property under test in this block is the SINGLE-SOURCE
// EXEMPTION -- see collapseCrossSourceDuplicates' own doc comment. The
// Dave & Buster's test is that property, not a curiosity.
describe("collapseCrossSourceDuplicates", () => {
  it("collapses the same event under different venue spellings", () => {
    const events = [
      event("Killer Of Sheep", "Philadelphia Film Society", "2026-08-20", { source: "Do215" }),
      event("Killer Of Sheep", "PFS Film Society Center, 1412 Chestnut Street, Philadelphia, PA 19102", "2026-08-20", {
        source: "Philadelphia Film Society",
      }),
    ];
    expect(collapseCrossSourceDuplicates(events)).toHaveLength(1);
  });

  it("does not collapse same-source entries at different venues", () => {
    // Regression for the false merge this design exists to avoid: five
    // real Dave & Buster's locations share a title on one date, all from
    // Do215. They are genuinely different rooms and must all survive.
    const locations = [
      "Dave & Buster's - Franklin Mills, Philadelphia, PA",
      "Dave & Buster's - Plymouth Meeting, Plymouth Meeting, PA",
      "Dave & Buster's - Gloucester, Blackwood, NJ",
      "Dave & Buster's, Philadelphia, PA",
      "Dave & Buster's - Philadelphia, Philadelphia, PA",
    ];
    const events = locations.map((v) => event("1 / 2 Price Games Wednesdays", v, "2026-08-26", { source: "Do215" }));
    expect(collapseCrossSourceDuplicates(events)).toHaveLength(5);
  });

  it("resolves by source priority", () => {
    const events = [
      event("Circle Jerks x Repo Man", "Keswick Theatre, Glenside, Pe", "2026-08-14", { source: "Do215" }),
      event("Circle Jerks x Repo Man", "Keswick Theatre", "2026-08-14", { source: "R5 Productions" }),
    ];
    const result = collapseCrossSourceDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("R5 Productions");
    expect(result[0]!.venue).toBe("Keswick Theatre");
  });

  it("normalizes punctuation and case in titles", () => {
    const events = [
      event('Christone "Kingfish" Ingram', "Upper Merion Township Building Park", "2026-08-13", { source: "Do215" }),
      event("christone kingfish ingram", "Concerts Under the Stars", "2026-08-13", { source: "WXPN" }),
    ];
    expect(collapseCrossSourceDuplicates(events)).toHaveLength(1);
  });

  it("keeps a numbered series distinct", () => {
    // Titles are never truncated for the key -- a prefix match would fuse
    // these, which really did all run in the same week.
    const events = ["Once Upon A Time In China", "Once Upon A Time In China Ii", "Once Upon A Time In China Iii"].map(
      (t) => event(t, "Philadelphia Film Society", "2026-08-19", { source: "Do215" }),
    );
    expect(collapseCrossSourceDuplicates(events)).toHaveLength(3);
  });

  it("does not collapse different dates", () => {
    const events = [
      event("Pusher", "Philadelphia Film Society", "2026-08-14", { source: "Do215" }),
      event("Pusher", "PFS Film Society Center", "2026-08-15", { source: "Philadelphia Film Society" }),
    ];
    expect(collapseCrossSourceDuplicates(events)).toHaveLength(2);
  });

  it("preserves a sold-out mention from the discarded entry", () => {
    const events = [
      event("Show", "Venue A", "2026-08-03", { source: "Do215", description: "Tickets are SOLD OUT." }),
      event("Show", "Venue A Annex", "2026-08-03", { source: "R5 Productions", description: "Doors at 7." }),
    ];
    const result = collapseCrossSourceDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("R5 Productions");
    expect(result[0]!.description!.toLowerCase()).toContain("sold out");
  });

  it("carries venue fields forward from the discarded entry", () => {
    // The tranche's load-bearing case: only do215/philly_ask_a_punk emit
    // venue_address/venue_id, and Do215 sits 4th in SOURCE_PRIORITY, so
    // whenever a higher-priority source also carries the event the winner
    // is the record WITHOUT the address. Without field-level carry-forward
    // merge_selections.ts sees nothing and the whole change silently no-ops.
    const events = [
      event("Show", "Venue A", "2026-08-03", {
        source: "Do215",
        venue_address: "531 N 12th St, Philadelphia, PA 19123",
        venue_id: "489700",
      }),
      event("Show", "Venue A Annex", "2026-08-03", { source: "R5 Productions" }),
    ];
    const result = collapseCrossSourceDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("R5 Productions");
    expect(result[0]!.venue_address).toBe("531 N 12th St, Philadelphia, PA 19123");
    expect(result[0]!.venue_id).toBe("489700");
  });

  it("does not overwrite venue fields the winner already has", () => {
    const events = [
      event("Show", "Venue A", "2026-08-03", { source: "Do215", venue_address: "111 Loser St" }),
      event("Show", "Venue A Annex", "2026-08-03", { source: "R5 Productions", venue_address: "222 Winner St" }),
    ];
    expect(collapseCrossSourceDuplicates(events)[0]!.venue_address).toBe("222 Winner St");
  });

  it("falls back to completeness on a source-priority tie", () => {
    const events = [
      event("Gig", "Room One", "2026-08-03", { source: "Unlisted A" }),
      event("Gig", "Room Two", "2026-08-03", { source: "Unlisted B", time: "7:00 PM", cost: "$10", url: "u" }),
    ];
    const result = collapseCrossSourceDuplicates(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("Unlisted B");
  });

  it("preserves input order of survivors", () => {
    const events = [
      event("Alpha", "V1", "2026-08-03", { source: "Do215" }),
      event("Beta", "V2", "2026-08-03", { source: "Do215" }),
      event("Beta", "V2 Annex", "2026-08-03", { source: "WXPN" }),
      event("Gamma", "V3", "2026-08-03", { source: "Do215" }),
    ];
    expect(collapseCrossSourceDuplicates(events).map((e) => e.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

function priorWeekOnDisk(root: string, name: string, picks: [string, string][]): void {
  const dir = join(root, name);
  mkdirSync(dir);
  const days = [
    {
      date: name,
      day_name: "Monday",
      top3: picks.map(([title, venue]) => ({ title, venue })),
      honorable_mentions: [],
      events: [],
    },
  ];
  writeFileSync(join(dir, "_selections.json"), JSON.stringify({ week: name, days }));
}

describe("buildRecentPicks (the cross-week sidecar)", () => {
  it("flattens prior weeks' top3 picks", () => {
    const root = makeTmpDir();
    priorWeekOnDisk(root, "2026-08-10", [["Killer Of Sheep", "Philadelphia Film Society"]]);
    priorWeekOnDisk(root, "2026-08-17", [["Dekalog: Parts 3 & 4", "Philadelphia Film Society"]]);
    mkdirSync(join(root, "2026-08-24"));
    const result = buildRecentPicks(join(root, "2026-08-24"));
    expect(result.week).toBe("2026-08-24");
    expect(new Set(result.recent_top3.map((p) => p.title))).toEqual(
      new Set(["Killer Of Sheep", "Dekalog: Parts 3 & 4"]),
    );
    expect(new Set(result.recent_top3.map((p) => p.week))).toEqual(new Set(["2026-08-10", "2026-08-17"]));
  });

  it("is empty for the earliest week", () => {
    const root = makeTmpDir();
    mkdirSync(join(root, "2026-06-22"));
    expect(buildRecentPicks(join(root, "2026-06-22")).recent_top3).toEqual([]);
  });

  it("carries only title, venue, week", () => {
    // The whole point is that it stays small enough for Selection to read
    // cheaply -- a full _selections.json runs ~1400 lines.
    const root = makeTmpDir();
    priorWeekOnDisk(root, "2026-08-17", [["A Show", "A Venue"]]);
    mkdirSync(join(root, "2026-08-24"));
    const entry = buildRecentPicks(join(root, "2026-08-24")).recent_top3[0]!;
    expect(new Set(Object.keys(entry))).toEqual(new Set(["title", "venue", "week"]));
  });
});

describe("groupRecurring", () => {
  it("passes through unchanged below the threshold", () => {
    const events = [event("Show", "Venue", "2026-08-03"), event("Show", "Venue", "2026-08-04")];
    const result = groupRecurring(events);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.recurrence_count === undefined)).toBe(true);
  });

  it("collapses to one annotated representative at the threshold", () => {
    const events = [
      event("Show", "Venue", "2026-08-05"),
      event("Show", "Venue", "2026-08-03"),
      event("Show", "Venue", "2026-08-04"),
    ];
    const result = groupRecurring(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.date).toBe("2026-08-03"); // earliest, not first-seen
    expect(result[0]!.occurrences).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(result[0]!.recurrence_count).toBe(3);
  });

  it("treats different venues as different series", () => {
    const events = [
      event("Show", "Venue A", "2026-08-03"),
      event("Show", "Venue B", "2026-08-04"),
      event("Show", "Venue A", "2026-08-05"),
    ];
    expect(groupRecurring(events)).toHaveLength(3); // only 2 occurrences at Venue A -- below threshold
  });

  it("counts repeated dates once toward the threshold", () => {
    // 4 raw entries but only 2 distinct dates -- should NOT group.
    const events = [
      event("Show", "Venue", "2026-08-03"),
      event("Show", "Venue", "2026-08-03"),
      event("Show", "Venue", "2026-08-04"),
      event("Show", "Venue", "2026-08-04"),
    ];
    const result = groupRecurring(events);
    expect(result).toHaveLength(4);
    expect(result.every((e) => e.recurrence_count === undefined)).toBe(true);
  });
});

describe("collectionFailures", () => {
  it("formats source and reason", () => {
    const manifest = { sources: { "free-library": { status: "failed", reason: "Cloudflare bot-check" } } };
    expect(collectionFailures(manifest)).toEqual(["free-library (Cloudflare bot-check)"]);
  });

  it("ignores ok sources", () => {
    const manifest = { sources: { do215: { status: "ok", events: 517 } } };
    expect(collectionFailures(manifest)).toEqual([]);
  });

  it("sorts alphabetically", () => {
    const manifest = {
      sources: { "zzz-source": { status: "failed", reason: "x" }, "aaa-source": { status: "failed", reason: "y" } },
    };
    expect(collectionFailures(manifest)).toEqual(["aaa-source (y)", "zzz-source (x)"]);
  });
});

describe("assignIds", () => {
  it("assigns sequential c0000-style ids in order", () => {
    const events = [event("A", "V", "2026-08-03"), event("B", "V", "2026-08-04"), event("C", "V", "2026-08-05")];
    expect(assignIds(events).map((c) => c.id)).toEqual(["c0000", "c0001", "c0002"]);
  });

  it("does not mutate the input list", () => {
    const events = [event("A", "V", "2026-08-03")];
    assignIds(events);
    expect(events[0]!.id).toBeUndefined();
  });

  it("is stable across repeated calls on the same order", () => {
    const events = [event("A", "V", "2026-08-03"), event("B", "V", "2026-08-04")];
    expect(assignIds(events)).toEqual(assignIds(events));
  });
});

describe("capDescriptions", () => {
  it("leaves short descriptions unchanged", () => {
    const events = [event("A", "V", "2026-08-03", { description: "short" })];
    expect(capDescriptions(events)[0]!.description).toBe("short");
  });

  it("truncates and appends an ellipsis", () => {
    const long = "x".repeat(700);
    const events = [event("A", "V", "2026-08-03", { description: long })];
    const result = capDescriptions(events, 600);
    expect(result[0]!.description).toHaveLength(601); // 600 chars + the ellipsis char
    expect(result[0]!.description!.endsWith("…")).toBe(true);
    expect(result[0]!.description!.slice(0, 600)).toBe("x".repeat(600));
  });

  it("does not mutate the input", () => {
    const events = [event("A", "V", "2026-08-03", { description: "x".repeat(700) })];
    capDescriptions(events, 600);
    expect(events[0]!.description).toHaveLength(700);
  });

  it("handles a missing description field", () => {
    const events: Candidate[] = [{ title: "A", venue: "V", date: "2026-08-03" }];
    expect(capDescriptions(events)).toEqual(events);
  });
});

describe("buildCandidates: id assignment + description cap wired in", () => {
  it("assigns a unique id to every candidate", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    const ids = result.candidates.map((c) => c.id!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(result.candidates.length);
    expect(ids.every((i) => i.startsWith("c"))).toBe(true);
  });

  it("caps a long description", () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, "_manifest.json"),
      JSON.stringify({ week: "2026-08-03", sources: { src: { status: "ok", events: 1 } } }),
    );
    writeFileSync(
      join(dir, "src.json"),
      JSON.stringify({
        source: "Some Source",
        events: [event("A", "V", "2026-08-03", { description: "y".repeat(900) })],
      }),
    );
    const result = buildCandidates(dir);
    expect(result.candidates[0]!.description).toHaveLength(601);
  });
});

describe("splitByDay", () => {
  it("writes one file per date in the week", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    const dir = makeTmpDir();
    const paths = splitByDay(result, dir);
    expect(paths).toHaveLength(7);
    expect(new Set(paths.map((p) => p.split("/").at(-1)))).toEqual(
      new Set([
        "2026-08-03.json",
        "2026-08-04.json",
        "2026-08-05.json",
        "2026-08-06.json",
        "2026-08-07.json",
        "2026-08-08.json",
        "2026-08-09.json",
      ]),
    );
  });

  it("withholds structured venue fields from Selection", () => {
    // Selection's ONLY input is the per-day files; merge_selections.ts
    // reads the monolithic _candidates.json. Keeping venue_address/
    // venue_id out of the per-day files is what lets the source's address
    // reach the merge without reaching the model.
    const dir = makeTmpDir();
    const result = {
      week: "2026-08-03",
      collection_failures: [],
      raw_event_count: 1,
      exact_duplicates_collapsed: 0,
      cross_source_duplicates_collapsed: 0,
      candidates: [
        event("Concert", "Venue", "2026-08-03", {
          id: "c0001",
          venue_address: "304 South St, Philadelphia, PA 19147",
          venue_id: "511812",
        }),
      ],
    };
    splitByDay(result, dir);
    const monday = JSON.parse(readFileSync(join(dir, "_candidates", "2026-08-03.json"), "utf8")) as {
      candidates: Candidate[];
    };
    const candidate = monday.candidates[0]!;
    expect(candidate.venue_address).toBeUndefined();
    expect(candidate.venue_id).toBeUndefined();
    // everything else still rides through untouched
    expect(candidate.title).toBe("Concert");
    expect(candidate.id).toBe("c0001");
    // ...and the monolithic result the merge reads is NOT mutated by the strip
    expect(result.candidates[0]!.venue_address).toBe("304 South St, Philadelphia, PA 19147");
  });

  it("places candidates on their own date", () => {
    // Both sample-week candidates (Museum Tour's earliest occurrence and
    // Concert Y) fall on the Monday -- the recurring candidate is grouped
    // to its earliest date by groupRecurring before splitByDay ever sees
    // it, so it appears only in that one day's file.
    const result = buildCandidates(SAMPLE_WEEK);
    const dir = makeTmpDir();
    splitByDay(result, dir);
    const monday = JSON.parse(readFileSync(join(dir, "_candidates", "2026-08-03.json"), "utf8")) as {
      candidates: Candidate[];
    };
    const tuesday = JSON.parse(readFileSync(join(dir, "_candidates", "2026-08-04.json"), "utf8")) as {
      candidates: Candidate[];
    };
    expect(new Set(monday.candidates.map((c) => c.title))).toEqual(new Set(["Museum Tour", "Concert Y"]));
    expect(tuesday.candidates).toEqual([]);
  });

  it("still gives empty days a file with the shared metadata", () => {
    const result = buildCandidates(SAMPLE_WEEK);
    const dir = makeTmpDir();
    splitByDay(result, dir);
    const sunday = JSON.parse(readFileSync(join(dir, "_candidates", "2026-08-09.json"), "utf8")) as {
      candidates: Candidate[];
      week: string;
      date: string;
      collection_failures: string[];
    };
    expect(sunday.candidates).toEqual([]);
    expect(sunday.week).toBe(result.week);
    expect(sunday.date).toBe("2026-08-09");
    expect(sunday.collection_failures).toEqual(result.collection_failures);
  });

  it("raises rather than silently dropping an out-of-window candidate", () => {
    // A candidate whose date falls outside the target week's Mon-Sun
    // window would otherwise vanish with no trace once per-day files are
    // Selection's only input -- must fail loudly rather than quietly omit.
    const dir = makeTmpDir();
    const result = {
      week: "2026-08-03",
      collection_failures: [],
      raw_event_count: 1,
      exact_duplicates_collapsed: 0,
      cross_source_duplicates_collapsed: 0,
      candidates: [event("Stray", "V", "2026-08-20", { id: "c0000" })],
    };
    expect(() => splitByDay(result, dir)).toThrowError(/Stray/);
  });

  it("is invisible to a non-recursive orphan-file glob", () => {
    // check_yield.ts's own future _loadWeekDir will list week_dir's *.json
    // files non-recursively -- verify that directly here so a false
    // assumption doesn't make every real Collection run fail its own
    // yield check once that script lands.
    const result = buildCandidates(SAMPLE_WEEK);
    const dir = makeTmpDir();
    for (const name of ["_manifest.json", "do215-like.json", "other-source.json"]) {
      writeFileSync(join(dir, name), readFileSync(join(SAMPLE_WEEK, name)));
    }
    splitByDay(result, dir);
    const filesOnDisk = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(filesOnDisk.some((f) => f.includes("_candidates"))).toBe(false);
  });
});

describe("normalizeTitle / priorityRank (unit-level sanity, beyond the dedupe-pass tests above)", () => {
  it("strips punctuation and casefolds", () => {
    expect(normalizeTitle('Christone "Kingfish" Ingram')).toBe(normalizeTitle("christone kingfish ingram"));
  });

  it("ranks unlisted sources below every listed one", () => {
    expect(priorityRank("Some Random Source")).toBeGreaterThan(priorityRank("Do215"));
  });
});
