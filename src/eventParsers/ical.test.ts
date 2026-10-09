/** ical.ts -- each case is a bug in scripts/event_parsers/_ical.py. */

import { describe, expect, it } from "vitest";
import { parseVEvents, unescapeText, unfold } from "./ical.js";

describe("unescapeText", () => {
  it("handles every RFC 5545 TEXT escape, including \\N", () => {
    expect(unescapeText("a\\, b\\; c\\nd\\Ne\\\\f")).toBe("a, b; c\nd\ne\\f");
  });
  it("treats an escaped backslash before 'n' as a literal backslash, not a newline", () => {
    // Python's chained .replace() turned "\\\\n" into a newline.
    expect(unescapeText("C:\\\\new")).toBe("C:\\new");
  });
});

describe("unfold", () => {
  it("joins continuations marked by a space or a tab, across CRLF, LF and CR", () => {
    expect(unfold("SUMMARY:Long\r\n  title\n\tcontinues\rNEXT:x")).toEqual(["SUMMARY:Long titlecontinues", "NEXT:x"]);
  });
});

describe("parseVEvents", () => {
  it("drops parameters, upper-cases names, and splits on the first unquoted colon", () => {
    const [event] = parseVEvents(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nlocation;ALTREP="http://x.org/a":Venue\nDTSTART;TZID=America/New_York:20260721T200000\nEND:VEVENT\nEND:VCALENDAR',
    );
    expect(event).toEqual({ LOCATION: "Venue", DTSTART: "20260721T200000" });
  });
  it("ignores a nested component's properties", () => {
    const [event] = parseVEvents(
      "BEGIN:VEVENT\nDESCRIPTION:The show\nBEGIN:VALARM\nDESCRIPTION:Reminder\nEND:VALARM\nSUMMARY:S\nEND:VEVENT",
    );
    expect(event).toEqual({ DESCRIPTION: "The show", SUMMARY: "S" });
  });
});
