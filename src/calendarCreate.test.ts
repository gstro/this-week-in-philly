/**
 * Port of tests/test_calendar_create.py, case for case, then TS-only tests:
 * the DST week, deletion across pages, tolerated deletes, exact request
 * bodies and `run()` end to end. calendarCreate is the pipeline's one
 * hard-to-undo mutation, so the service is always a recording fake and no
 * test reaches the real calendar.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_END_TIME_DELTA_MINUTES,
  END_TIME_DELTA_MINUTES,
  type Deps,
  type TopPick,
  buildEvent,
  clearTargetWeek,
  parseStart,
  parseTime,
  run,
  weekHasAlreadyBegun,
} from "./calendarCreate.js";
import { CATEGORY_ORDER } from "./common.js";
import { type CalendarEventsService, type EventBody, type EventsListParams, type EventsPage } from "./lib/calendar.js";

const MUSIC = CATEGORY_ORDER[0];
const LITERARY = CATEGORY_ORDER[2];
const TECH = CATEGORY_ORDER[5];

function pick(fields: Partial<TopPick> = {}): TopPick {
  return { title: "A Show", time: "6:00 PM", category: MUSIC, why: "why", cost: "", url: "", ...fields };
}

const DAY = { date: "2026-06-22" };

// --- parseStart / parseTime ---

describe("parseStart", () => {
  it("parses a real time", () => {
    expect(parseStart("2026-06-22", "6:00 PM")).toBe(18 * 60);
  });

  it("is null for an empty, placeholder or malformed time", () => {
    expect(parseStart("2026-06-22", "")).toBeNull();
    expect(parseStart("2026-06-22", "*(confirm showtimes)*")).toBeNull();
    expect(parseStart("2026-06-22", "not a time")).toBeNull();
  });

  it("is null for an impossible date", () => {
    expect(parseStart("2026-02-30", "6:00 PM")).toBeNull();
  });
});

describe("parseTime", () => {
  it.each([
    ["12:00 AM", 0],
    ["12:30 PM", 12 * 60 + 30],
    ["1:05 am", 65],
    ["11:59 pm", 23 * 60 + 59],
    ["  6:00   PM ", 18 * 60],
  ])("%s", (text, minutes) => {
    expect(parseTime(text)).toBe(minutes);
  });

  it.each(["13:00 PM", "0:30 AM", "6:60 PM", "6:00", "6:00PM", "6 PM", "6:0 PM", "18:00", "6:00 XM"])("rejects %s", (text) => {
    expect(parseTime(text)).toBeNull();
  });
});

// --- buildEvent ---

describe("buildEvent", () => {
  it("returns null and warns on an unparseable time", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(buildEvent(DAY, pick({ title: "Mystery Show", time: "" }))).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Mystery Show"));
    error.mockRestore();
  });

  it("writes Eastern timestamps with the offset, no milliseconds and no Z", () => {
    const event = buildEvent(DAY, pick())!;
    expect(event.start.dateTime).toBe("2026-06-22T18:00:00-04:00");
    expect(event.end.dateTime).toBe("2026-06-22T21:00:00-04:00");
  });

  it("uses a category-specific end time", () => {
    const event = buildEvent(DAY, pick({ category: LITERARY }))!;
    expect(event.end.dateTime).toBe("2026-06-22T19:30:00-04:00");
    expect(END_TIME_DELTA_MINUTES[LITERARY]).toBe(90);
  });

  it("falls back to +2h for the categories with no documented heuristic", () => {
    const event = buildEvent(DAY, pick({ category: TECH }))!;
    expect(event.end.dateTime).toBe("2026-06-22T20:00:00-04:00");
    expect(END_TIME_DELTA_MINUTES[TECH]).toBeUndefined();
    expect(DEFAULT_END_TIME_DELTA_MINUTES).toBe(120);
  });

  it("rolls an end time past midnight into the next day", () => {
    const event = buildEvent(DAY, pick({ time: "11:30 PM" }))!;
    expect(event.start.dateTime).toBe("2026-06-22T23:30:00-04:00");
    expect(event.end.dateTime).toBe("2026-06-23T02:30:00-04:00");
  });

  it("gives the 11-01 fall-back day the standard-time offset, even for an end time that rolls into it", () => {
    expect(buildEvent({ date: "2026-11-01" }, pick({ time: "8:00 PM" }))!.start.dateTime).toBe("2026-11-01T20:00:00-05:00");
    const rolled = buildEvent({ date: "2026-10-31" }, pick({ time: "11:30 PM" }))!;
    expect(rolled.start.dateTime).toBe("2026-10-31T23:30:00-04:00");
    expect(rolled.end.dateTime).toBe("2026-11-01T02:30:00-05:00");
  });

  it("gives a wall time in the spring-forward gap the offset from before the change, as Python's zoneinfo does", () => {
    const event = buildEvent({ date: "2026-03-07" }, pick({ time: "11:00 PM" }))!;
    expect(event.start.dateTime).toBe("2026-03-07T23:00:00-05:00");
    expect(event.end.dateTime).toBe("2026-03-08T02:00:00-05:00");
  });

  it("omits location without an address and sets it from one", () => {
    expect(buildEvent(DAY, pick())).not.toHaveProperty("location");
    expect(buildEvent(DAY, pick({ address: "404 S. 20th St., Philadelphia, PA 19146" }))!.location).toBe(
      "404 S. 20th St., Philadelphia, PA 19146",
    );
  });

  it("omits the cost line for a placeholder cost and includes a confirmed one", () => {
    expect(buildEvent(DAY, pick({ cost: "*(confirm details)*" }))!.description).not.toContain("Cost:");
    expect(buildEvent(DAY, pick({ cost: "$15 adv" }))!.description).toContain("Cost: $15 adv");
  });

  it("builds the description from why, cost and url, joined by blank lines", () => {
    const event = buildEvent(DAY, pick({ why: "The blurb.", cost: "$15 adv", url: "https://example.com/event" }))!;
    expect(event.description).toBe("The blurb.\n\nCost: $15 adv\n\nhttps://example.com/event");
  });

  it("uses the title as the summary", () => {
    expect(buildEvent(DAY, pick({ title: "The Big Show" }))!.summary).toBe("The Big Show");
  });
});

// --- weekHasAlreadyBegun ---

describe("weekHasAlreadyBegun (the 2026-08-23 incident guard)", () => {
  it("is true for a past Monday", () => {
    expect(weekHasAlreadyBegun("2026-08-17", "2026-08-23")).toBe(true);
  });

  it("is false for the upcoming week: the on-schedule path is never refused", () => {
    expect(weekHasAlreadyBegun("2026-08-24", "2026-08-23")).toBe(false);
  });

  it("is false on the Monday itself (`<`, not `!==`)", () => {
    expect(weekHasAlreadyBegun("2026-08-24", "2026-08-24")).toBe(false);
  });
});

// --- recording fake service ---

type Call =
  | { op: "list"; params: EventsListParams }
  | { op: "delete"; eventId: string }
  | { op: "insert"; body: EventBody };

class FakeService implements CalendarEventsService {
  readonly calls: Call[] = [];
  private page = 0;
  readonly events: CalendarEventsService["events"];

  constructor(
    pages: EventsPage[] = [{ items: [] }],
    failDelete: (eventId: string) => Error | undefined = () => undefined,
    failInsert: (body: EventBody) => Error | undefined = () => undefined,
  ) {
    this.events = {
      list: (params): Promise<{ data: EventsPage }> => {
        this.calls.push({ op: "list", params });
        return Promise.resolve({ data: pages[this.page++] ?? { items: [] } });
      },
      delete: ({ eventId }): Promise<unknown> => {
        this.calls.push({ op: "delete", eventId });
        const err = failDelete(eventId);
        return err ? Promise.reject(err) : Promise.resolve({});
      },
      insert: ({ requestBody }): Promise<unknown> => {
        this.calls.push({ op: "insert", body: requestBody });
        const err = failInsert(requestBody);
        return err ? Promise.reject(err) : Promise.resolve({});
      },
    };
  }

  ops(): string[] {
    return this.calls.map((call) => call.op);
  }
}

// --- clearTargetWeek ---

describe("clearTargetWeek", () => {
  it("deletes every existing event in the range", async () => {
    const service = new FakeService([{ items: [{ id: "evt-1" }, { id: "evt-2" }] }]);
    expect(await clearTargetWeek(service, "cal-id", "2026-06-22")).toBe(2);
    expect(service.calls.filter((c) => c.op === "delete")).toEqual([
      { op: "delete", eventId: "evt-1" },
      { op: "delete", eventId: "evt-2" },
    ]);
  });

  it("queries exactly [monday, monday+7d) in Eastern, not the prior week (the D2 regression)", async () => {
    const service = new FakeService();
    await clearTargetWeek(service, "cal-id", "2026-06-22");
    expect(service.calls[0]).toEqual({
      op: "list",
      params: {
        calendarId: "cal-id",
        timeMin: "2026-06-22T00:00:00-04:00",
        timeMax: "2026-06-29T00:00:00-04:00",
        singleEvents: true,
      },
    });
  });

  it("queries the DST-crossing week 2026-10-26 with each end's own offset", async () => {
    const service = new FakeService();
    await clearTargetWeek(service, "cal-id", "2026-10-26");
    const call = service.calls[0];
    expect(call?.op === "list" && [call.params.timeMin, call.params.timeMax]).toEqual([
      "2026-10-26T00:00:00-04:00",
      "2026-11-02T00:00:00-05:00",
    ]);
  });

  it("leaves alone an event that started before the week (a Sunday-night event running into Monday)", async () => {
    const service = new FakeService([
      {
        items: [
          { id: "last-week", start: { dateTime: "2026-06-21T23:00:00-04:00" } },
          { id: "monday", start: { dateTime: "2026-06-22T00:00:00-04:00" } },
          { id: "all-day", start: { date: "2026-06-23" } },
          { id: "no-start" },
        ],
      },
    ]);
    expect(await clearTargetWeek(service, "cal-id", "2026-06-22")).toBe(3);
    expect(service.calls.filter((c) => c.op === "delete")).toEqual(
      ["monday", "all-day", "no-start"].map((eventId) => ({ op: "delete", eventId })),
    );
  });

  it("returns zero when there is nothing to clear", async () => {
    expect(await clearTargetWeek(new FakeService(), "cal-id", "2026-06-22")).toBe(0);
  });

  it("lists every page before deleting anything (deleting while paging can skip events)", async () => {
    const service = new FakeService([
      { items: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" },
      { items: [{ id: "c" }] },
    ]);
    expect(await clearTargetWeek(service, "cal-id", "2026-06-22")).toBe(3);
    expect(service.ops()).toEqual(["list", "list", "delete", "delete", "delete"]);
    expect(service.calls[1]).toMatchObject({ params: { pageToken: "p2" } });
  });

  it.each([404, 410])("counts a delete answered %i as deleted", async (status) => {
    const service = new FakeService([{ items: [{ id: "a" }, { id: "b" }] }], (id) =>
      id === "a" ? Object.assign(new Error("gone"), { status }) : undefined,
    );
    expect(await clearTargetWeek(service, "cal-id", "2026-06-22")).toBe(2);
    expect(service.ops()).toEqual(["list", "delete", "delete"]);
  });

  it("propagates any other delete failure", async () => {
    const service = new FakeService([{ items: [{ id: "a" }, { id: "b" }] }], () =>
      Object.assign(new Error("forbidden"), { code: 403 }),
    );
    await expect(clearTargetWeek(service, "cal-id", "2026-06-22")).rejects.toThrow("forbidden");
    expect(service.ops()).toEqual(["list", "delete"]);
  });
});

// --- run() ---

function selections(monday: string, picks: TopPick[] = [pick({ time: "7:00 PM", cost: "$10", why: "Because it is a show." })]): unknown {
  return { week: monday, days: [{ date: monday, day_name: "Monday", top3: picks, honorable_mentions: [], events: [] }] };
}

describe("run", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "calendar-create-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function weekDir(monday: string, picks?: TopPick[]): string {
    const path = join(dir, monday);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "_selections.json"), JSON.stringify(selections(monday, picks)));
    return path;
  }

  /** Deps whose getService throws: reaching auth is the failure these tests exist to catch. */
  function booby(today: string): { deps: Deps; reached: string[] } {
    const reached: string[] = [];
    return {
      reached,
      deps: {
        today: () => today,
        getService: (): ReturnType<NonNullable<Deps["getService"]>> => {
          reached.push("getService");
          return Promise.reject(new Error("calendarCreate reached Google auth on a guarded run"));
        },
      },
    };
  }

  it("refuses a past week and touches nothing: the incident replay", async () => {
    const { deps, reached } = booby("2026-08-23");
    expect(await run([weekDir("2026-08-17")], deps)).toBe(0);
    expect(reached).toEqual([]);
    expect(out.join("\n")).toContain("REFUSING");
    expect(out.join("\n")).toContain("2026-08-17");
    expect(out.join("\n")).toContain("6 day(s) ago");
  });

  it("refuses a past week even with --dry-run", async () => {
    const { deps, reached } = booby("2026-08-23");
    expect(await run([weekDir("2026-08-17"), "--dry-run"], deps)).toBe(0);
    expect(reached).toEqual([]);
    expect(out.join("\n")).toContain("REFUSING");
  });

  it("lets the upcoming week through the guard (reaching the dry-run branch proves it)", async () => {
    const { deps, reached } = booby("2026-08-23");
    expect(await run([weekDir("2026-08-24"), "--dry-run"], deps)).toBe(0);
    expect(reached).toEqual([]);
    expect(out.join("\n")).not.toContain("REFUSING");
    expect(out.join("\n")).toContain("[dry-run] Would clear existing events for week of 2026-08-24 and create 1 new events.");
  });

  it("--force-calendar overrides the guard", async () => {
    const { deps, reached } = booby("2026-08-23");
    expect(await run([weekDir("2026-08-17"), "--dry-run", "--force-calendar"], deps)).toBe(0);
    expect(reached).toEqual([]);
    expect(out.join("\n")).not.toContain("REFUSING");
    expect(out.join("\n")).toContain("[dry-run]");
  });

  it("--dry-run never reaches auth on the upcoming week", async () => {
    const { deps, reached } = booby("2026-08-23");
    await run([weekDir("2026-08-24"), "--dry-run"], deps);
    expect(reached).toEqual([]);
  });

  it("clears the week, then inserts each event in order with the exact bodies", async () => {
    const service = new FakeService([{ items: [{ id: "old-1" }] }]);
    const picks = [
      pick({ title: "First", time: "7:00 PM", cost: "$10", why: "One.", address: "1 Main St" }),
      pick({ title: "Skipped", time: "" }),
      pick({ title: "Second", time: "9:00 PM", category: LITERARY, why: "Two.", url: "https://example.com/2" }),
    ];
    const code = await run([weekDir("2026-08-24", picks)], {
      today: () => "2026-08-23",
      getService: () => Promise.resolve({ service, calendarId: "cal-id" }),
    });
    expect(code).toBe(0);
    expect(service.ops()).toEqual(["list", "delete", "insert", "insert"]);
    expect(service.calls.filter((c) => c.op === "insert").map((c) => (c.op === "insert" ? c.body : null))).toEqual([
      {
        summary: "First",
        start: { dateTime: "2026-08-24T19:00:00-04:00" },
        end: { dateTime: "2026-08-24T22:00:00-04:00" },
        description: "One.\n\nCost: $10",
        location: "1 Main St",
      },
      {
        summary: "Second",
        start: { dateTime: "2026-08-24T21:00:00-04:00" },
        end: { dateTime: "2026-08-24T22:30:00-04:00" },
        description: "Two.\n\nhttps://example.com/2",
      },
    ]);
    expect(out).toEqual(["Calendar sync complete. Cleared 1 stale events, created 2 events for week of 2026-08-24."]);
    expect(err.join("\n")).toContain("Skipped");
  });

  it("reports an insert failure on one line and exits 1, leaving the partial week for a re-run", async () => {
    const service = new FakeService([{ items: [] }], () => undefined, (body) => (body.summary === "Second" ? new Error("quota exceeded") : undefined));
    const code = await run([weekDir("2026-08-24", [pick({ title: "First" }), pick({ title: "Second" })])], {
      today: () => "2026-08-23",
      getService: () => Promise.resolve({ service, calendarId: "cal-id" }),
    });
    expect(code).toBe(1);
    expect(err).toEqual(["calendar_create: quota exceeded"]);
  });

  it("rejects a malformed first date before the guard can misorder it", async () => {
    const { deps, reached } = booby("2026-10-10");
    expect(await run([weekDir("2026-8-17")], deps)).toBe(1);
    expect(reached).toEqual([]);
    expect(err.join("\n")).toContain("not YYYY-MM-DD");
  });

  it("exits 1 with a message when the week has no selections", async () => {
    expect(await run([join(dir, "missing")], { today: () => "2026-08-23" })).toBe(1);
    expect(err.join("\n")).toContain("Selections have not run for this week");
  });

  it("exits 2 with usage for bad arguments", async () => {
    expect(await run([])).toBe(2);
    expect(await run(["a", "b"])).toBe(2);
    expect(await run(["a", "--nope"])).toBe(2);
    expect(err.join("\n")).toContain("usage: calendarCreate.js");
  });
});
