/**
 * Ported from tests/test_merge_selections.py.
 *
 * All fixtures are small inline objects, not files on disk -- the merge logic
 * is pure functions over already-parsed JSON, following
 * prepareSelectionInput.test.ts's precedent of not needing disk I/O to
 * exercise transform logic. The Python suite's two subprocess-based CLI cases
 * are not ported: this repo's TS suite verifies compiled-CLI behavior in the
 * PR's manual test plan (as PR #37 did), not in vitest.
 */

import { describe, expect, it } from "vitest";
import type { Candidate } from "./prepareSelectionInput.js";
import {
  type Annotation,
  type AnnotationDay,
  type AnnotationsDoc,
  type CandidatesDoc,
  type Top3Entry,
  type Top3Pick,
  MergeError,
  buildEvents,
  buildHonorableMentions,
  buildTop3,
  merge,
  parseTimeForSort,
} from "./mergeSelections.js";

const MUSIC = "🎵 Music & Concerts";
const FILM = "🎬 Film & Cinema";

function candidate(id: string, title: string, venue: string, date: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title,
    venue,
    date,
    time: "7:00 PM",
    cost: "$10",
    url: `https://example.com/${id}`,
    source: "Some Source",
    description: "",
    ...overrides,
  };
}

function candidatesDoc(candidates: Candidate[], collectionFailures: string[] = []): CandidatesDoc {
  return {
    week: "2026-08-03",
    collection_failures: collectionFailures,
    raw_event_count: candidates.length,
    candidates,
  };
}

function annotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return { id, category: MUSIC, sold_out: false, ...overrides };
}

function top3Pick(id: string, overrides: Partial<Top3Pick> = {}): Top3Pick {
  return { id, rank: 1, category: MUSIC, is_music: true, sold_out: false, why: "Great show.", ...overrides };
}

function day(date: string, overrides: Partial<AnnotationDay> = {}): AnnotationDay {
  return { date, day_name: "Monday", top3: [], honorable_mentions: [], annotations: [], ...overrides };
}

function annotationsDoc(days: AnnotationDay[], overrides: Partial<AnnotationsDoc> = {}): AnnotationsDoc {
  return { week: "2026-08-03", collection_failures: [], days, ...overrides };
}

describe("merge: end-to-end happy path", () => {
  it("reconciles a simple day with one top3 and one listed event", () => {
    const candidates = candidatesDoc([
      candidate("c0000", "Saetia", "First Unitarian Church", "2026-08-03", { cost: "$15", source: "R5 Productions" }),
      candidate("c0001", "Bright Bulb Screenings", "The Rotunda", "2026-08-03", { cost: "Free", source: "The Rotunda" }),
    ]);
    const annotations = annotationsDoc([
      day("2026-08-03", {
        top3: [top3Pick("c0000", { rank: 1, category: MUSIC, why: "Rare reunion show.", address: "2125 Chestnut St" })],
        annotations: [annotation("c0000"), annotation("c0001", { category: FILM, note: "Monthly repertory night." })],
      }),
    ]);
    const result = merge(candidates, annotations);
    expect(result.week).toBe("2026-08-03");
    expect(result.total_events_after_dedup).toBe(2);
    const merged = result.days[0]!;
    expect(merged.top3).toHaveLength(1);
    expect(merged.top3[0]).toEqual({
      rank: 1,
      title: "Saetia",
      venue: "First Unitarian Church",
      address: "2125 Chestnut St",
      time: "7:00 PM",
      cost: "$15",
      url: "https://example.com/c0000",
      category: MUSIC,
      source: "R5 Productions",
      is_music: true,
      sold_out: false,
      why: "Rare reunion show.",
    });
    expect(merged.events).toHaveLength(2); // both the top3 pick and the plain listing
  });

  it("puts a top3 pick in events[] with its annotated note and no is_music", () => {
    const candidates = candidatesDoc([candidate("c0000", "Saetia", "Venue", "2026-08-03")]);
    const annotations = annotationsDoc([
      day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000", { note: "Also a benefit show." })] }),
    ]);
    const event = merge(candidates, annotations).days[0]!.events[0]!;
    expect(event.title).toBe("Saetia");
    expect(event.note).toBe("Also a benefit show.");
    expect(event).not.toHaveProperty("is_music"); // zero consumers read is_music off events[]
  });
});

describe("id resolution failures", () => {
  it("raises on a top3 id matching no candidate", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c9999")], annotations: [annotation("c9999")] })]);
    expect(() => merge(candidates, annotations)).toThrow(MergeError);
    expect(() => merge(candidates, annotations)).toThrow(/c9999/);
  });

  it("raises when a top3 id's candidate belongs to another day", () => {
    // A day-agent misfiling an event under the wrong date -- the id resolves,
    // but to a candidate that belongs to a different day.
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-04")]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] })]);
    expect(() => merge(candidates, annotations)).toThrow(/c0000.*2026-08-04.*2026-08-03/s);
  });

  it("raises when a top3 id is absent from that day's annotations", () => {
    // Otherwise the pick would have no entry in events[].
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [] })]);
    expect(() => merge(candidates, annotations)).toThrow(/c0000/);
  });

  it("raises when an honorable mention id is absent from annotations", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { honorable_mentions: [{ id: "c0000" }], annotations: [] })]);
    expect(() => merge(candidates, annotations)).toThrow(/c0000/);
  });

  it("raises on an honorable mention id matching no candidate", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([
      day("2026-08-03", { honorable_mentions: [{ id: "c9999" }], annotations: [annotation("c9999")] }),
    ]);
    expect(() => merge(candidates, annotations)).toThrow(/c9999/);
  });

  it("raises when an annotation omits category", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [{ id: "c0000", sold_out: false }] })]);
    expect(() => merge(candidates, annotations)).toThrow(/category/);
  });

  it("defaults a missing annotation sold_out to false rather than raising", () => {
    // sold_out has a safe default -- requiring it on every one of the ~350
    // annotations a week would fail the whole merge over a model omitting an
    // occasionally-false boolean, exactly the compression that happens at
    // volume. Only fields with no safe default (category) are required.
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [{ id: "c0000", category: MUSIC }] })]);
    expect(merge(candidates, annotations).days[0]!.events[0]!.sold_out).toBe(false);
  });

  it("defaults a top3's missing sold_out and is_music to false rather than raising", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const pick: Top3Pick = { id: "c0000", rank: 1, category: MUSIC, why: "Great show." };
    const annotations = annotationsDoc([day("2026-08-03", { top3: [pick], annotations: [annotation("c0000")] })]);
    const merged = merge(candidates, annotations).days[0]!.top3[0]!;
    expect(merged.sold_out).toBe(false);
    expect(merged.is_music).toBe(false);
  });

  it("raises on a non-canonical annotation category", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000", { category: "Music" })] })]);
    expect(() => merge(candidates, annotations)).toThrow(/Music/);
  });

  it("raises when an annotated candidate belongs to another day", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-04")]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000")] })]);
    expect(() => merge(candidates, annotations)).toThrow(/c0000/);
  });

  it("raises when a top3 pick omits a required field", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03")]);
    const annotations = annotationsDoc([
      day("2026-08-03", { top3: [{ id: "c0000", rank: 1 }], annotations: [annotation("c0000")] }),
    ]);
    expect(() => merge(candidates, annotations)).toThrow(/why|category/);
  });
});

describe("verbatim field copying", () => {
  it("copies title, venue, time, cost, url and source verbatim onto events", () => {
    const only = candidate("c0000", "The Show", "The Venue", "2026-08-03", { time: "9:30 PM", cost: "$20", source: "Luma" });
    const events = buildEvents(day("2026-08-03", { annotations: [annotation("c0000")] }), candidatesDoc([only]));
    expect(events[0]).toMatchObject({
      title: "The Show",
      venue: "The Venue",
      time: "9:30 PM",
      cost: "$20",
      url: "https://example.com/c0000",
      source: "Luma",
    });
  });

  it("defaults a top3's blank candidate cost to 'Not listed'", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03", { cost: "" })]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] })]);
    expect(merge(candidates, annotations).days[0]!.top3[0]!.cost).toBe("Not listed");
  });

  it("defaults a listed event's blank candidate cost to 'Not listed'", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03", { cost: "" })]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000")] })]);
    expect(merge(candidates, annotations).days[0]!.events[0]!.cost).toBe("Not listed");
  });

  it("defaults a top3's time to the candidate's verbatim time", () => {
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03", { time: "7:00 PM" })]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] })]);
    expect(merge(candidates, annotations).days[0]!.top3[0]!.time).toBe("7:00 PM");
  });

  it("lets a time override clean up a genuinely messy raw candidate time", () => {
    // The one exception to verbatim copying: a candidate's raw time can be
    // genuinely malformed straight out of Collection (e.g. "7:00, 7:30", no
    // AM/PM) -- confirmed on 2 of the 5 real 2026-08-03 top3 picks that lost
    // their calendar entry this way.
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03", { time: "7:00, 7:30" })]);
    const annotations = annotationsDoc([
      day("2026-08-03", { top3: [top3Pick("c0000", { time: "7:00 PM" })], annotations: [annotation("c0000")] }),
    ]);
    expect(merge(candidates, annotations).days[0]!.top3[0]!.time).toBe("7:00 PM");
  });

  it("raises on a messy candidate time with no override", () => {
    // Regression test for the real 2026-08-17 defect: two top3 picks omitted
    // the `time` override, so the resolved time fell through to the
    // candidate's raw "7:00, 7:30" -- unparseable by calendar_create.py's
    // parse_start(), which silently skipped both picks' calendar entries.
    // check_selection.py flagged this as WARN, so the week published with two
    // silently-missing calendar events.
    const candidates = candidatesDoc([
      candidate("c0000", "Philadelphia Psychotronic Film Society", "PhilaMOCA", "2026-08-03", { time: "7:00, 7:30" }),
    ]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] })]);
    expect(() => merge(candidates, annotations)).toThrow(/c0000.*7:00, 7:30/s);
  });

  it("raises on a blank candidate time with no override", () => {
    // parseStart() also returns null on an empty string -- the merge guard
    // must cover the omission case, not just the malformed-value case.
    const candidates = candidatesDoc([candidate("c0000", "A", "V", "2026-08-03", { time: "" })]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] })]);
    expect(() => merge(candidates, annotations)).toThrow(/c0000/);
  });

  it("resolves top3 titles from the candidate, not the annotation", () => {
    // Closes the real 62-of-562 drift bug: Selection never gets to retype a
    // title -- it can only reference a candidate id, so top3's title always
    // matches events[]'s title exactly.
    const candidates = candidatesDoc([candidate("c0000", "Exact Original Title", "V", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] })]);
    const merged = merge(candidates, annotations).days[0]!;
    expect(merged.top3[0]!.title).toBe("Exact Original Title");
    expect(merged.events.some((e) => e.title === "Exact Original Title")).toBe(true);
  });
});

describe("category ordering + chronological tie-break", () => {
  it("groups by category order, then chronologically", () => {
    const candidates = candidatesDoc([
      candidate("c0000", "Film Late", "V", "2026-08-03", { time: "9:00 PM" }),
      candidate("c0001", "Music Early", "V", "2026-08-03", { time: "6:00 PM" }),
      candidate("c0002", "Film Early", "V", "2026-08-03", { time: "5:00 PM" }),
    ]);
    const annotations = annotationsDoc([
      day("2026-08-03", {
        annotations: [
          annotation("c0000", { category: FILM }),
          annotation("c0001", { category: MUSIC }),
          annotation("c0002", { category: FILM }),
        ],
      }),
    ]);
    // Music & Concerts sorts before Film & Cinema per CATEGORY_ORDER;
    // within Film & Cinema, 5:00 PM sorts before 9:00 PM.
    expect(merge(candidates, annotations).days[0]!.events.map((e) => e.title)).toEqual([
      "Music Early",
      "Film Early",
      "Film Late",
    ]);
  });

  it("breaks same-time ties by original candidate order, not annotation order", () => {
    const candidates = candidatesDoc([
      candidate("c0000", "Second In Candidates", "V", "2026-08-03", { time: "7:00 PM" }),
      candidate("c0001", "First In Candidates", "V", "2026-08-03", { time: "7:00 PM" }),
    ]);
    // Annotations list them in the opposite order -- the tie-break must
    // follow _candidates.json's order, not the annotations list's order.
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0001"), annotation("c0000")] })]);
    expect(merge(candidates, annotations).days[0]!.events.map((e) => e.title)).toEqual([
      "Second In Candidates",
      "First In Candidates",
    ]);
  });

  it("sorts an unparseable or missing time last within its category", () => {
    const candidates = candidatesDoc([
      candidate("c0000", "No Time", "V", "2026-08-03", { time: "" }),
      candidate("c0001", "Has Time", "V", "2026-08-03", { time: "7:00 PM" }),
    ]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000"), annotation("c0001")] })]);
    expect(merge(candidates, annotations).days[0]!.events.map((e) => e.title)).toEqual(["Has Time", "No Time"]);
  });
});

describe("parseTimeForSort: strptime('%I:%M %p') semantics, deliberately not TIME_RE's", () => {
  it("parses a clean time to minutes since midnight", () => {
    expect(parseTimeForSort("7:00 PM")).toBe(19 * 60);
    expect(parseTimeForSort("12:00 AM")).toBe(0);
    expect(parseTimeForSort("12:30 PM")).toBe(12 * 60 + 30);
  });

  it("accepts what strptime accepts but the merge guard rejects", () => {
    // %p is case-insensitive, %M takes one or two digits, and the format's
    // single space matches a run of whitespace.
    expect(parseTimeForSort("7:00 pm")).toBe(19 * 60);
    expect(parseTimeForSort("7:5 PM")).toBe(19 * 60 + 5);
    expect(parseTimeForSort("7:00  PM")).toBe(19 * 60);
  });

  it("rejects what strptime rejects even though the merge guard accepts it", () => {
    // %I is 1-12, so a 24-hour value never parses here.
    expect(parseTimeForSort("13:00 PM")).toBeNull();
  });

  it("returns null for a non-string, porting Python's `except TypeError`", () => {
    // A raw scraped time can be a list; unlike strptime, a JS regex would
    // coerce it to a matching string.
    expect(parseTimeForSort(["7:00 PM"])).toBeNull();
    expect(parseTimeForSort(undefined)).toBeNull();
    expect(parseTimeForSort("")).toBeNull();
  });
});

describe("round trip: every annotated candidate appears exactly once", () => {
  it("lists each annotated candidate once", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${String(i).padStart(4, "0")}`);
    const candidates = candidatesDoc(ids.map((id, i) => candidate(id, `Event ${String(i)}`, "V", "2026-08-03")));
    const annotations = annotationsDoc([
      day("2026-08-03", {
        annotations: ids.map((id, i) => annotation(id, { category: i % 2 === 0 ? MUSIC : FILM })),
      }),
    ]);
    const titles = merge(candidates, annotations).days[0]!.events.map((e) => e.title);
    expect([...titles].sort()).toEqual([...ids.map((_, i) => `Event ${String(i)}`)].sort());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("simply does not list a candidate with no annotation", () => {
    // Not every candidate needs to be annotated -- the per-category cap
    // (Phase 3) means some candidates are legitimately dropped from the
    // report, not every one of them a bug.
    const candidates = candidatesDoc([
      candidate("c0000", "Listed", "V", "2026-08-03"),
      candidate("c0001", "Unlisted", "V", "2026-08-03"),
    ]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000")] })]);
    expect(merge(candidates, annotations).days[0]!.events.map((e) => e.title)).toEqual(["Listed"]);
  });
});

describe("honorable mentions", () => {
  it("carries only title and venue", () => {
    const candidates = candidatesDoc([candidate("c0000", "HM Event", "HM Venue", "2026-08-03")]);
    const annotations = annotationsDoc([
      day("2026-08-03", { honorable_mentions: [{ id: "c0000" }], annotations: [annotation("c0000")] }),
    ]);
    expect(merge(candidates, annotations).days[0]!.honorable_mentions).toEqual([{ title: "HM Event", venue: "HM Venue" }]);
  });

  it("appends the (SOLD OUT) suffix html_render.py bolds", () => {
    const candidates = candidatesDoc([candidate("c0000", "HM Event", "HM Venue", "2026-08-03")]);
    const annotations = annotationsDoc([
      day("2026-08-03", { honorable_mentions: [{ id: "c0000" }], annotations: [annotation("c0000", { sold_out: true })] }),
    ]);
    expect(merge(candidates, annotations).days[0]!.honorable_mentions[0]!.title).toBe("HM Event (SOLD OUT)");
  });

  it("adds no suffix when not sold out", () => {
    const candidates = candidatesDoc([candidate("c0000", "HM Event", "HM Venue", "2026-08-03")]);
    const annotations = annotationsDoc([
      day("2026-08-03", { honorable_mentions: [{ id: "c0000" }], annotations: [annotation("c0000", { sold_out: false })] }),
    ]);
    expect(merge(candidates, annotations).days[0]!.honorable_mentions[0]!.title).toBe("HM Event");
  });
});

describe("mergeDay", () => {
  it("raises a MergeError, not a bare property access, on a day missing date", () => {
    const annotations = annotationsDoc([{ day_name: "Monday", top3: [], honorable_mentions: [], annotations: [] }]);
    expect(() => merge(candidatesDoc([]), annotations)).toThrow(MergeError);
    expect(() => merge(candidatesDoc([]), annotations)).toThrow(/date/);
  });
});

describe("collection_failures passthrough", () => {
  it("takes them from the annotations doc", () => {
    const result = merge(
      candidatesDoc([], ["from-candidates (x)"]),
      annotationsDoc([], { collection_failures: ["from-annotations (y)"] }),
    );
    expect(result.collection_failures).toEqual(["from-annotations (y)"]);
  });

  it("falls back to the candidates doc when the annotations doc omits the key", () => {
    const result = merge(candidatesDoc([], ["from-candidates (x)"]), { week: "2026-08-03", days: [] });
    expect(result.collection_failures).toEqual(["from-candidates (x)"]);
  });
});

describe("buildTop3 / buildHonorableMentions in isolation", () => {
  it("omits address when neither side provides one", () => {
    const only = candidate("c0000", "A", "V", "2026-08-03");
    const picks = buildTop3(
      day("2026-08-03", { top3: [top3Pick("c0000")], annotations: [annotation("c0000")] }),
      new Map([["c0000", only]]),
      new Map([["c0000", annotation("c0000")]]),
    );
    expect(picks[0]).not.toHaveProperty("address");
  });

  it("returns an empty list when a day has no honorable mentions", () => {
    expect(buildHonorableMentions(day("2026-08-03"), new Map(), new Map())).toEqual([]);
  });
});

describe("address resolution: the source's venue_address vs Selection's own", () => {
  function mergeOne(candidateOverrides: Partial<Candidate>, pickAddress?: string): Top3Entry {
    const candidates = candidatesDoc([candidate("c0000", "Show", "Venue", "2026-08-03", candidateOverrides)]);
    const annotations = annotationsDoc([
      day("2026-08-03", {
        top3: [top3Pick("c0000", pickAddress === undefined ? {} : { address: pickAddress })],
        annotations: [annotation("c0000")],
      }),
    ]);
    return merge(candidates, annotations).days[0]!.top3[0]!;
  }

  it("prefers the source's venue_address over Selection's", () => {
    // The live 2026-08-31 defect: Selection put Cherry Street Pier at "301 S
    // Christopher Columbus Blvd" -- an address it also gave Spruce Street
    // Harbor, pooling two venues and pinning the calendar entry about a mile
    // off. Do215's own venue record says 121 N. The source wins, and the
    // disagreement is kept so check_selection.py can report it.
    const entry = mergeOne(
      { venue_address: "121 N Christopher Columbus Blvd, Philadelphia, PA 19106", venue_id: "500714" },
      "301 S Christopher Columbus Blvd, Philadelphia, PA 19106",
    );
    expect(entry.address).toBe("121 N Christopher Columbus Blvd, Philadelphia, PA 19106");
    expect(entry.selection_address).toBe("301 S Christopher Columbus Blvd, Philadelphia, PA 19106");
    expect(entry.venue_id).toBe("500714");
  });

  it("backfills the address when Selection omitted one", () => {
    // 2026-08-24 shipped 6 of 21 picks with no address, so 6 calendar entries
    // had no location at all. A source address fills that gap.
    const entry = mergeOne({ venue_address: "304 South St, Philadelphia, PA 19147" });
    expect(entry.address).toBe("304 South St, Philadelphia, PA 19147");
    expect(entry).not.toHaveProperty("selection_address");
  });

  it("keeps Selection's address when the source has none", () => {
    const entry = mergeOne({}, "2125 Chestnut St");
    expect(entry.address).toBe("2125 Chestnut St");
    // nothing to disagree with, so no duplicate copy is recorded
    expect(entry).not.toHaveProperty("selection_address");
  });

  it("omits address entirely when neither side has one", () => {
    const entry = mergeOne({});
    expect(entry).not.toHaveProperty("address");
    expect(entry).not.toHaveProperty("venue_address");
  });
});

describe("recurrence carried through for the All Week table", () => {
  it("carries recurrence fields onto listed events", () => {
    // groupRecurring() has emitted occurrences/recurrence_count since the v2
    // data layout landed; they never survived this merge, which is why the
    // spec'd All Week table never rendered in six published weeks.
    const candidates = candidatesDoc([
      candidate("c0000", "Rent", "Playhouse", "2026-08-03", {
        recurrence_count: 6,
        occurrences: ["2026-08-03", "2026-08-04", "2026-08-05"],
      }),
    ]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000")] })]);
    const event = merge(candidates, annotations).days[0]!.events[0]!;
    expect(event.recurrence_count).toBe(6);
    expect(event.occurrences).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
  });

  it("omits recurrence fields for a normal one-off event", () => {
    const candidates = candidatesDoc([candidate("c0000", "One Night", "Venue", "2026-08-03")]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000")] })]);
    const event = merge(candidates, annotations).days[0]!.events[0]!;
    expect(event).not.toHaveProperty("recurrence_count");
    expect(event).not.toHaveProperty("occurrences");
  });

  it("omits an empty occurrences list, matching Python truthiness", () => {
    // A bare `[]` is falsy in Python and truthy in JS -- without an explicit
    // length check the TS port would emit a key the Python never does.
    const candidates = candidatesDoc([candidate("c0000", "One Night", "Venue", "2026-08-03", { occurrences: [] })]);
    const annotations = annotationsDoc([day("2026-08-03", { annotations: [annotation("c0000")] })]);
    expect(merge(candidates, annotations).days[0]!.events[0]!).not.toHaveProperty("occurrences");
  });
});
