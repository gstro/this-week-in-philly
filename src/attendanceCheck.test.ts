/**
 * Port of tests/test_attendance_check.py, case for case, plus a TS-only block
 * at the end pinning what attendanceCheck.ts reimplements by hand: the
 * zoneinfo-faithful events.list window, the request shape, and run()'s
 * end-to-end CSV bytes and messages. Every expected value there was taken
 * from CPython 3.12 (.venv) running scripts/attendance_check.py, not
 * reasoned out.
 *
 * attendance_check.py is NOT wired into runner.sh (the attendance/picks-log
 * feedback loop is deferred); these tests exist so neither implementation
 * rots while shelved. The calendar is always a fake: nothing here may reach
 * the real "Curated Events" calendar, which holds the attendance signal.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarEventsService,
  type EventsListParams,
  type EventsPage,
  calendarWeekWindow,
  easternMidnightIso,
  fetchCalendarTitles,
  lastWeekMonday,
  run,
  updateAttendance,
} from "./attendanceCheck.js";
import type { CsvDictRow } from "./csvLog.js";

function row(fields: Record<string, string>): CsvDictRow {
  return new Map(Object.entries(fields));
}

// --- lastWeekMonday ---

describe("lastWeekMonday", () => {
  it("is exactly seven days before", () => {
    expect(lastWeekMonday("2026-06-22")).toBe("2026-06-15");
  });

  it("crosses a month boundary", () => {
    expect(lastWeekMonday("2026-07-06")).toBe("2026-06-29");
  });
});

// --- fetchCalendarTitles ---

class FakeService implements CalendarEventsService {
  readonly listCalls: EventsListParams[] = [];
  private calls = 0;
  readonly events: CalendarEventsService["events"];

  constructor(pages: EventsPage[]) {
    this.events = {
      list: (params: EventsListParams): Promise<{ data: EventsPage }> => {
        this.listCalls.push(params);
        const page = pages[this.calls++];
        if (page === undefined) throw new Error("FakeService: no more pages");
        return Promise.resolve({ data: page });
      },
    };
  }
}

describe("fetchCalendarTitles", () => {
  it("collects summaries", async () => {
    const service = new FakeService([{ items: [{ summary: "NFC Sculpture Workshop" }, { summary: "Gothic Night" }] }]);
    const titles = await fetchCalendarTitles(service, "cal-id", "2026-06-15");
    expect(titles).toEqual(new Set(["NFC Sculpture Workshop", "Gothic Night"]));
  });

  it("ignores events with no summary", async () => {
    const service = new FakeService([{ items: [{ summary: "Has One" }, {}] }]);
    const titles = await fetchCalendarTitles(service, "cal-id", "2026-06-15");
    expect(titles).toEqual(new Set(["Has One"]));
  });

  it("paginates", async () => {
    const service = new FakeService([
      { items: [{ summary: "First Page Event" }], nextPageToken: "page2" },
      { items: [{ summary: "Second Page Event" }] },
    ]);
    const titles = await fetchCalendarTitles(service, "cal-id", "2026-06-15");
    expect(titles).toEqual(new Set(["First Page Event", "Second Page Event"]));
  });

  it("returns an empty set for an empty week", async () => {
    const service = new FakeService([{ items: [] }]);
    expect(await fetchCalendarTitles(service, "cal-id", "2026-06-15")).toEqual(new Set());
  });
});

// --- updateAttendance ---

describe("updateAttendance", () => {
  it("marks present titles true", () => {
    const rows = [row({ city: "Philadelphia", week_of: "2026-06-15", title: "NFC Sculpture Workshop", attended: "" })];
    const updated = updateAttendance(rows, "2026-06-15", new Set(["NFC Sculpture Workshop"]));
    expect(updated).toBe(1);
    expect(rows[0]!.get("attended")).toBe("true");
  });

  it("marks absent titles false", () => {
    const rows = [row({ city: "Philadelphia", week_of: "2026-06-15", title: "Skipped Event", attended: "" })];
    const updated = updateAttendance(rows, "2026-06-15", new Set());
    expect(updated).toBe(1);
    expect(rows[0]!.get("attended")).toBe("false");
  });

  // calendar_create only creates events for the 21 Top 3 picks, never
  // honorable mentions -- so an HM row can never be "present" and must
  // always resolve to false, never left blank. Confirmed as v1's actual
  // historical behavior too.
  it("honorable mention rows always resolve false", () => {
    const rows = [
      row({ city: "Philadelphia", week_of: "2026-06-15", title: "An Honorable Mention", rank: "HM", attended: "" }),
    ];
    updateAttendance(rows, "2026-06-15", new Set(["Some Other Event"]));
    expect(rows[0]!.get("attended")).toBe("false");
  });

  it("skips rows from other weeks", () => {
    const rows = [row({ city: "Philadelphia", week_of: "2026-06-08", title: "Different Week Event", attended: "" })];
    const updated = updateAttendance(rows, "2026-06-15", new Set());
    expect(updated).toBe(0);
    expect(rows[0]!.get("attended")).toBe(""); // untouched
  });

  it("skips non-Philadelphia rows", () => {
    const rows = [row({ city: "Austin", week_of: "2026-06-15", title: "Austin Event", attended: "" })];
    const updated = updateAttendance(rows, "2026-06-15", new Set(["Austin Event"]));
    expect(updated).toBe(0);
    expect(rows[0]!.get("attended")).toBe(""); // untouched -- city filter, not just title match
  });

  it("returns the count of rows touched", () => {
    const rows = [
      row({ city: "Philadelphia", week_of: "2026-06-15", title: "A", attended: "" }),
      row({ city: "Philadelphia", week_of: "2026-06-15", title: "B", attended: "" }),
      row({ city: "Philadelphia", week_of: "2026-06-08", title: "C", attended: "" }),
    ];
    expect(updateAttendance(rows, "2026-06-15", new Set(["A"]))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TS-only: values below are CPython 3.12 output.
// ---------------------------------------------------------------------------

describe("calendar week window (datetime.combine(..., tzinfo=ZoneInfo) + timedelta(days=7))", () => {
  it.each([
    ["2026-06-15", "2026-06-15T00:00:00-04:00", "2026-06-22T00:00:00-04:00"],
    ["2026-01-05", "2026-01-05T00:00:00-05:00", "2026-01-12T00:00:00-05:00"],
    // DST starts 2026-03-08: wall-clock arithmetic, so the offsets differ.
    ["2026-03-02", "2026-03-02T00:00:00-05:00", "2026-03-09T00:00:00-04:00"],
    ["2026-03-09", "2026-03-09T00:00:00-04:00", "2026-03-16T00:00:00-04:00"],
    // DST ends 2026-11-01.
    ["2026-10-26", "2026-10-26T00:00:00-04:00", "2026-11-02T00:00:00-05:00"],
    ["2026-11-02", "2026-11-02T00:00:00-05:00", "2026-11-09T00:00:00-05:00"],
    // Pre-1883 LMT: isoformat() adds seconds for a non-whole-minute offset.
    ["1883-11-12", "1883-11-12T00:00:00-04:56:02", "1883-11-19T00:00:00-05:00"],
    ["1800-01-06", "1800-01-06T00:00:00-04:56:02", "1800-01-13T00:00:00-04:56:02"],
  ])("%s", (monday, timeMin, timeMax) => {
    expect(calendarWeekWindow(monday)).toEqual({ timeMin, timeMax });
  });

  it.each([
    ["America/Sao_Paulo", "2018-11-04", "2018-11-04T00:00:00-03:00"], // midnight skipped: pre-transition
    ["America/Havana", "2023-03-12", "2023-03-12T00:00:00-05:00"], // midnight skipped: pre-transition
    ["America/Havana", "2023-11-05", "2023-11-05T00:00:00-04:00"], // midnight repeated: first (fold=0)
    ["Asia/Kolkata", "2026-06-15", "2026-06-15T00:00:00+05:30"],
    ["Pacific/Chatham", "2026-06-15", "2026-06-15T00:00:00+12:45"],
  ])("follows zoneinfo's fold=0 rule in %s on %s", (zone, day, expected) => {
    expect(easternMidnightIso(day, zone)).toBe(expected);
  });

  it("rejects a non-YYYY-MM-DD date and an out-of-range result", () => {
    expect(() => lastWeekMonday("2026-02-30")).toThrow(/Invalid isoformat/);
    expect(() => lastWeekMonday("0001-01-03")).toThrow(/OverflowError/);
  });
});

describe("fetchCalendarTitles request shape", () => {
  it("sends the Eastern window, singleEvents, and pageToken only after the first page", async () => {
    const service = new FakeService([{ items: [], nextPageToken: "p2" }, { items: [] }]);
    await fetchCalendarTitles(service, "cal-id", "2026-03-02");
    const base = {
      calendarId: "cal-id",
      timeMin: "2026-03-02T00:00:00-05:00",
      timeMax: "2026-03-09T00:00:00-04:00",
      singleEvents: true,
    };
    expect(service.listCalls).toEqual([base, { ...base, pageToken: "p2" }]);
    expect(Object.hasOwn(service.listCalls[0]!, "pageToken")).toBe(false);
  });
});

describe("run (end to end, fake calendar)", () => {
  const HEADER = "city,week_of,day,date,title,venue,category,source,rank,price_tier,spotify_link,tags,attended\r\n";
  const LOG =
    HEADER +
    'Philadelphia,2026-06-15,Monday,2026-06-15,"Gothic Night, Vol. 2",Venue A,music,Do215,1,free,,,\r\n' +
    "Philadelphia,2026-06-15,Monday,2026-06-15,Skipped Event,Venue B,film,Do215,2,paid,,,\r\n" +
    "Philadelphia,2026-06-15,Monday,2026-06-15,An HM,Venue C,arts,Do215,HM,,,,\r\n" +
    "Philadelphia,2026-06-08,Monday,2026-06-08,Gothic Night,Venue A,music,Do215,1,free,,,true\r\n" +
    "Austin,2026-06-15,Monday,2026-06-15,Skipped Event,Venue D,music,X,1,free,,,\r\n";

  let dir: string;
  let logPath: string;
  let out: string[];
  let fetches: string[];
  const fakeFetch =
    (titles: string[]) =>
    (monday: string): Promise<Set<string>> => {
      fetches.push(monday);
      return Promise.resolve(new Set(titles));
    };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attendance-"));
    logPath = join(dir, "log.csv");
    vi.stubEnv("PICKS_LOG_PATH", logPath);
    out = [];
    fetches = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      out.push(msg);
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("updates only last week's Philadelphia rows and rewrites the file", async () => {
    writeFileSync(logPath, LOG.replace(/\r\n/g, "\n")); // \n input; the writer emits \r\n
    await run({ weekDir: "data/2026-06-22/", dryRun: false }, fakeFetch(["Gothic Night, Vol. 2", "skipped event"]));
    expect(fetches).toEqual(["2026-06-15"]);
    expect(readFileSync(logPath, "utf8")).toBe(
      HEADER +
        'Philadelphia,2026-06-15,Monday,2026-06-15,"Gothic Night, Vol. 2",Venue A,music,Do215,1,free,,,true\r\n' +
        "Philadelphia,2026-06-15,Monday,2026-06-15,Skipped Event,Venue B,film,Do215,2,paid,,,false\r\n" +
        "Philadelphia,2026-06-15,Monday,2026-06-15,An HM,Venue C,arts,Do215,HM,,,,false\r\n" +
        "Philadelphia,2026-06-08,Monday,2026-06-08,Gothic Night,Venue A,music,Do215,1,free,,,true\r\n" +
        "Austin,2026-06-15,Monday,2026-06-15,Skipped Event,Venue D,music,X,1,free,,,\r\n",
    );
    expect(out).toEqual(["Attendance check complete. 3 rows updated for week_of=2026-06-15 (1 attended, 2 not attended)."]);
  });

  it("--dry-run fetches and reports but leaves the file untouched", async () => {
    writeFileSync(logPath, LOG);
    await run({ weekDir: "data/2026-06-22", dryRun: true }, fakeFetch(["Skipped Event"]));
    expect(fetches).toEqual(["2026-06-15"]);
    expect(readFileSync(logPath, "utf8")).toBe(LOG);
    expect(out).toEqual(["[dry-run] Would update 3 rows for week_of=2026-06-15 (1 attended, 2 not attended)."]);
  });

  it("a missing log is a no-op and never fetches", async () => {
    await run({ weekDir: "data/2026-06-22", dryRun: false }, fakeFetch([]));
    expect(fetches).toEqual([]);
    expect(existsSync(logPath)).toBe(false);
    expect(out).toEqual([`No picks log at ${logPath}; nothing to check.`]);
  });

  it("no rows for last week skips before fetching", async () => {
    writeFileSync(logPath, LOG);
    await run({ weekDir: "data/2026-07-06", dryRun: false }, fakeFetch([]));
    expect(fetches).toEqual([]);
    expect(readFileSync(logPath, "utf8")).toBe(LOG);
    expect(out).toEqual(["No Philadelphia rows for week_of=2026-06-29; skipping."]);
  });

  it("an empty log raises (no header row)", async () => {
    writeFileSync(logPath, "");
    await expect(run({ weekDir: "data/2026-06-22", dryRun: false }, fakeFetch([]))).rejects.toThrow(
      /RuntimeError: .* has no header row/,
    );
  });

  // Latent Python bug, reproduced: the file is truncated before DictWriter
  // validates each row, so a long row loses itself and everything after it.
  it("a row longer than the header raises mid-write, leaving a truncated log", async () => {
    writeFileSync(
      logPath,
      HEADER +
        "Philadelphia,2026-06-15,Monday,2026-06-15,A,V,music,S,1,free,,,\r\n" +
        "Philadelphia,2026-06-15,Monday,2026-06-15,B,V,music,S,2,free,,,,extra\r\n" +
        "Philadelphia,2026-06-15,Monday,2026-06-15,C,V,music,S,3,free,,,\r\n",
    );
    await expect(run({ weekDir: "data/2026-06-22", dryRun: false }, fakeFetch(["A"]))).rejects.toThrow(
      "ValueError: dict contains fields not in fieldnames: None",
    );
    expect(readFileSync(logPath, "utf8")).toBe(
      HEADER + "Philadelphia,2026-06-15,Monday,2026-06-15,A,V,music,S,1,free,,,true\r\n",
    );
  });

  // Same bug via a header without `attended`: updateAttendance adds the key,
  // so the very first row raises and only the header survives.
  it("a log without an attended column is truncated to its header", async () => {
    writeFileSync(logPath, "city,week_of,title\r\nPhiladelphia,2026-06-15,A\r\n");
    await expect(run({ weekDir: "data/2026-06-22", dryRun: false }, fakeFetch(["A"]))).rejects.toThrow(
      "ValueError: dict contains fields not in fieldnames: 'attended'",
    );
    expect(readFileSync(logPath, "utf8")).toBe("city,week_of,title\r\n");
  });
});
