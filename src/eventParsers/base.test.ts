/** base.ts date/time and event helpers. */

import { describe, expect, it } from "vitest";
import { MalformedRecord, ParseError, collectRecords, easternDateTime, formatTime, isoDate, makeEvent, parseIsoDateTime, parseMonth } from "./base.js";

describe("isoDate", () => {
  it("validates real calendar dates", () => {
    expect(isoDate(2028, 2, 29)).toBe("2028-02-29");
    expect(isoDate(2026, 2, 29)).toBeNull();
    expect(isoDate(2026, 13, 1)).toBeNull();
  });
});

describe("parseMonth", () => {
  it("reads names and abbreviations case-insensitively", () => {
    expect(parseMonth(" Sept ")).toBe(9);
    expect(parseMonth("OCT")).toBe(10);
    expect(parseMonth("Smarch")).toBeNull();
  });
});

describe("formatTime", () => {
  it("formats a 12-hour clock like strftime('%-I:%M %p')", () => {
    expect(formatTime(0, 5)).toBe("12:05 AM");
    expect(formatTime(12, 0)).toBe("12:00 PM");
    expect(formatTime(19, 45)).toBe("7:45 PM");
  });
  it("rejects impossible times as a malformed record", () => {
    expect(() => formatTime(24, 0)).toThrow(MalformedRecord);
    expect(() => formatTime(7, 60)).toThrow(MalformedRecord);
  });
});

describe("easternDateTime", () => {
  it("follows DST, including across the transition day", () => {
    expect(easternDateTime(Date.UTC(2026, 10, 1, 5, 30))).toEqual({ date: "2026-11-01", time: "1:30 AM" }); // EDT
    expect(easternDateTime(Date.UTC(2026, 10, 1, 6, 30))).toEqual({ date: "2026-11-01", time: "1:30 AM" }); // EST, repeated hour
    expect(easternDateTime(Date.UTC(2026, 6, 23, 2, 0))).toEqual({ date: "2026-07-22", time: "10:00 PM" });
  });
});

describe("parseIsoDateTime", () => {
  it("shows an offset-bearing timestamp in Philadelphia time", () => {
    expect(parseIsoDateTime("2026-08-05T19:00:00-04:00")).toEqual({ date: "2026-08-05", time: "7:00 PM" });
    expect(parseIsoDateTime("2026-08-05T23:30:00Z")).toEqual({ date: "2026-08-05", time: "7:30 PM" });
    expect(parseIsoDateTime("2026-12-05T01:00:00+0000")).toEqual({ date: "2026-12-04", time: "8:00 PM" });
  });
  it("keeps a naive timestamp's wall clock and gives a bare date no time", () => {
    expect(parseIsoDateTime("2026-08-05 19:00")).toEqual({ date: "2026-08-05", time: "7:00 PM" });
    expect(parseIsoDateTime("2026-08-05")).toEqual({ date: "2026-08-05", time: "" });
  });
  it("returns null for non-ISO text and throws for an impossible ISO value", () => {
    expect(parseIsoDateTime("next Tuesday")).toBeNull();
    expect(() => parseIsoDateTime("2026-02-30T19:00:00-05:00")).toThrow(MalformedRecord);
    expect(() => parseIsoDateTime("2026-08-05T25:00:00-04:00")).toThrow(MalformedRecord);
  });
});

describe("makeEvent", () => {
  it("trims every field and omits empty venue metadata", () => {
    expect(
      makeEvent({ title: " T ", venue: "V ", date: "2026-08-05", time: " ", cost: "", url: " u", description: "d", venue_address: "  ", venue_id: "7" }),
    ).toEqual({ title: "T", venue: "V", date: "2026-08-05", time: "", cost: "", url: "u", description: "d", venue_id: "7" });
  });
});

describe("collectRecords", () => {
  const ev = (title: string): ReturnType<typeof makeEvent> => makeEvent({ title, venue: "", date: "2026-10-12", time: "", cost: "", url: "", description: "" });
  const toEvent = (item: string): ReturnType<typeof makeEvent> | null => {
    if (item === "bad") throw new MalformedRecord("bad record");
    return item === "skip" ? null : ev(item);
  };

  it("skips a malformed record when others are well-formed", () => {
    expect(collectRecords("t", ["a", "bad", "skip"], toEvent).map((e) => e.title)).toEqual(["a"]);
  });

  it("an all-malformed source is a ParseError, not an empty ok source", () => {
    expect(() => collectRecords("t", ["bad", "bad"], toEvent)).toThrow(ParseError);
  });

  it("well-formed records filtered out (none in week) still return []", () => {
    expect(collectRecords("t", ["skip", "bad"], toEvent)).toEqual([]);
    expect(collectRecords("t", [], toEvent)).toEqual([]);
  });
});
