import { describe, expect, it } from "vitest";
import { addDays, easternIso, todayEastern } from "./calendar.js";

describe("todayEastern", () => {
  it("is the Eastern date, not the UTC date", () => {
    expect(todayEastern(new Date("2026-08-24T02:00:00Z"))).toBe("2026-08-23");
    expect(todayEastern(new Date("2026-08-24T05:00:00Z"))).toBe("2026-08-24");
  });

  it("follows the standard-time offset in winter", () => {
    expect(todayEastern(new Date("2026-12-07T04:59:00Z"))).toBe("2026-12-06");
    expect(todayEastern(new Date("2026-12-07T05:00:00Z"))).toBe("2026-12-07");
  });
});

describe("easternIso", () => {
  it("formats the wall time with the offset in force then", () => {
    expect(easternIso("2026-06-22", 18, 5)).toBe("2026-06-22T18:05:00-04:00");
    expect(easternIso("2026-12-07", 9, 0)).toBe("2026-12-07T09:00:00-05:00");
  });

  it("switches offset across the transition days", () => {
    expect(easternIso("2026-03-08", 1, 59)).toBe("2026-03-08T01:59:00-05:00");
    expect(easternIso("2026-03-08", 3, 0)).toBe("2026-03-08T03:00:00-04:00");
    expect(easternIso("2026-11-01", 0, 30)).toBe("2026-11-01T00:30:00-04:00");
    expect(easternIso("2026-11-01", 3, 0)).toBe("2026-11-01T03:00:00-05:00");
  });

  it("resolves the skipped and repeated hours as Python's zoneinfo does (fold=0)", () => {
    expect(easternIso("2026-03-08", 2, 0)).toBe("2026-03-08T02:00:00-05:00"); // skipped: pre-change offset
    expect(easternIso("2026-03-08", 2, 30)).toBe("2026-03-08T02:30:00-05:00");
    expect(easternIso("2026-11-01", 1, 30)).toBe("2026-11-01T01:30:00-04:00"); // repeated: first occurrence
  });
});

describe("addDays", () => {
  it("rejects an impossible date", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(/not a YYYY-MM-DD date/);
  });
});
