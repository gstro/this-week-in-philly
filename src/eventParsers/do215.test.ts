// Tests for the Do215 SvelteKit-endpoint parser. The real-capture cases read
// raw __data.json responses saved 2026-11-01 (tests/fixtures/do215-sveltekit/);
// the rest are synthetic events in the same shape for the rules a capture
// can't isolate.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dayPagePayload } from "../lib/devalueTestUtil.js";
import { type Event, ParseError } from "./base.js";
import { decodeDayPage, parse } from "./do215.js";

const CAPTURES = join(import.meta.dirname, "..", "..", "tests", "fixtures", "do215-sveltekit");
const capture = (name: string): unknown => JSON.parse(readFileSync(join(CAPTURES, name), "utf8")) as unknown;
const WEEK_START = "2026-11-02";
const WEEK_END = "2026-11-08";

/** A real week-of-2026-11-02 Monday: both pages of it, merged as the collector does. */
function mondayEvents(): unknown[] {
  return ["2026-11-02-page1.json", "2026-11-02-page2.json"].flatMap((name) => decodeDayPage(capture(name)).events);
}
const parseWeek = (events: unknown[], start = WEEK_START, end = WEEK_END): Event[] => parse(JSON.stringify({ events }), start, end);

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    type: "event",
    title: "Show",
    permalink: "/events/2026/11/4/show-tickets",
    event_type: "single_day",
    occurrence_date: "2026-11-04",
    tz_adjusted_begin_time: "2026-11-04T20:00:00-05:00",
    tz_adjusted_end_time: null,
    category: "Music",
    genres: [],
    venue: { id: 99, title: "Some Venue", district_name: "Fishtown", area_name: "Northeast" },
    ...overrides,
  };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("decodeDayPage (real captures)", () => {
  it("reads events and the page count from the first and last pages of a day", () => {
    const first = decodeDayPage(capture("2026-11-02-page1.json"));
    const last = decodeDayPage(capture("2026-11-02-page2.json"));
    expect(first.totalPages).toBe(2);
    expect(first.events).toHaveLength(20);
    expect(last.events).toHaveLength(13); // 33 that day, 20 on the first page
  });

  it("finds the browse node whichever position it is in", () => {
    const page = capture("2026-11-02-page1.json") as { nodes: unknown[] };
    const reversed = { type: "data", nodes: [...page.nodes].reverse() };
    expect(decodeDayPage(reversed).events).toHaveLength(20);
  });
});

describe("decodeDayPage (shape errors)", () => {
  it("rejects what is not a SvelteKit data payload", () => {
    expect(() => decodeDayPage("<html>")).toThrow(ParseError);
    expect(() => decodeDayPage({ events: [] })).toThrow(/no 'nodes' array/);
  });

  it("rejects a payload with no browse node, or a browse without its paging", () => {
    expect(() => decodeDayPage({ type: "data", nodes: [{ type: "skip" }, { type: "error" }] })).toThrow(/no data node carries 'browse'/);
    const noMeta = dayPagePayload([], 1) as { nodes: { data: unknown[] }[] };
    noMeta.nodes[1]!.data = [{ browse: 1 }, { data: 2 }, []];
    expect(() => decodeDayPage(noMeta)).toThrow(/no data\/_meta/);
  });

  it("rejects a total_pages that is not a whole number", () => {
    expect(() => decodeDayPage(dayPagePayload([], 1.5))).toThrow(/total_pages/);
  });
});

describe("parse (real Monday, 2026-11-02)", () => {
  it("maps a plain single-day event", () => {
    const events = parseWeek(mondayEvents());
    const taylor = events.find((e) => e.title === "Taylor Tomlinson");
    expect(taylor).toEqual({
      title: "Taylor Tomlinson",
      venue: "Helium Comedy Club",
      date: "2026-11-02",
      time: "6:30 PM",
      cost: "",
      url: "https://do215.com/events/2026/11/2/taylor-tomlinson-tickets",
      description: "Comedy · Center City, Rittenhouse Square",
      venue_id: "489710",
    });
    expect(taylor).not.toHaveProperty("venue_address");
  });

  it("keeps a weekly repeat on its occurrence date, not its series start", () => {
    const quizzo = parseWeek(mondayEvents()).find((e) => e.title === "Carbon Copy Quizzo");
    expect(quizzo).toMatchObject({ date: "2026-11-02", time: "7:00 PM" });
  });

  it("drops the multi-month exhibit that covers the whole week", () => {
    const events = parseWeek(mondayEvents());
    expect(events.some((e) => e.title.startsWith("STRANGER THINGS"))).toBe(false);
    expect(events).toHaveLength(32); // 33 listings less the one multi_day run
  });

  it("drops every listing when the target week is elsewhere", () => {
    expect(parseWeek(mondayEvents(), "2026-11-09", "2026-11-15")).toEqual([]);
  });
});

describe("parse (rules)", () => {
  it("dates by occurrence_date and reads the time from tz_adjusted_begin_time", () => {
    const weekly = event({
      event_type: "weekly_repeating",
      occurrence_date: "2026-11-03",
      tz_adjusted_begin_time: "2026-05-12T19:00:00-04:00", // series start, in daylight time
    });
    expect(parseWeek([weekly])[0]).toMatchObject({ date: "2026-11-03", time: "7:00 PM" });
  });

  it("keeps a daily event once per day but collapses a repeat within a day", () => {
    const events = parseWeek([
      event({ id: 5, occurrence_date: "2026-11-03", event_type: "weekly_repeating" }),
      event({ id: 5, occurrence_date: "2026-11-04", event_type: "weekly_repeating" }),
      event({ id: 5, occurrence_date: "2026-11-04", event_type: "weekly_repeating" }),
    ]);
    expect(events.map((e) => e.date)).toEqual(["2026-11-03", "2026-11-04"]);
  });

  it("drops a multi_day run that spans the week and one with no end", () => {
    const spans = event({ id: 8, event_type: "multi_day", tz_adjusted_begin_time: "2026-10-01T10:00:00-04:00", tz_adjusted_end_time: "2026-12-31T18:00:00-05:00" });
    const noEnd = event({ id: 9, event_type: "multi_day", tz_adjusted_end_time: null });
    expect(parseWeek([spans, noEnd])).toEqual([]);
  });

  it("keeps a shorter multi_day run once, on its first in-window day", () => {
    const festival = (day: string): Record<string, unknown> =>
      event({
        id: 12,
        title: "Festival",
        event_type: "multi_day",
        occurrence_date: day,
        tz_adjusted_begin_time: "2026-10-30T12:00:00-04:00",
        tz_adjusted_end_time: "2026-11-04T22:00:00-05:00",
      });
    const events = parseWeek([festival("2026-11-02"), festival("2026-11-03"), festival("2026-11-04")]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Festival", date: "2026-11-02", time: "12:00 PM" });
  });

  it("skips listings outside the week", () => {
    expect(parseWeek([event({ occurrence_date: "2026-11-01" }), event({ id: 2, occurrence_date: "2026-11-09" })])).toEqual([]);
  });

  it("describes category, genres and area; leaves cost empty", () => {
    const [parsed] = parseWeek([event({ category: "Music", genres: ["Indie & Alternative", "Folk & Blues"] })]);
    expect(parsed?.description).toBe("Music (Indie & Alternative, Folk & Blues) · Northeast, Fishtown");
    expect(parsed?.cost).toBe("");
  });

  it("reads missing optional fields as empty, never 'null'", () => {
    const [parsed] = parseWeek([event({ permalink: null, category: null, genres: null, tz_adjusted_begin_time: null, venue: { title: null } })]);
    expect(parsed).toEqual({ title: "Show", venue: "", date: "2026-11-04", time: "", cost: "", url: "", description: "" });
  });

  it("skips a record with no title or no usable date, and says so", () => {
    expect(parseWeek([event({ title: null }), event({ id: 2, occurrence_date: null }), event({ id: 3, title: "Fine" })]).map((e) => e.title)).toEqual(["Fine"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no title"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("occurrence_date"));
  });

  it("skips only the record whose venue is not an object", () => {
    expect(parseWeek([event({ venue: "Somewhere" }), event({ id: 2, title: "Good" })]).map((e) => e.title)).toEqual(["Good"]);
  });
});

describe("parse (shape errors)", () => {
  it("throws on a missing events key, a non-list, and invalid JSON", () => {
    expect(() => parse(JSON.stringify({ paging: {} }), WEEK_START, WEEK_END)).toThrow(ParseError);
    expect(() => parse(JSON.stringify({ events: "x" }), WEEK_START, WEEK_END)).toThrow(ParseError);
    expect(() => parse("not json", WEEK_START, WEEK_END)).toThrow(ParseError);
  });

  it("treats an empty events list as a valid, empty result", () => {
    expect(parseWeek([])).toEqual([]);
  });
});
