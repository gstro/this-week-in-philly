import { join } from "node:path";
import type { calendar_v3 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATA_DIR,
  REPO_ROOT,
  getCalendarCredentials,
  getCalendarId,
  isFreeCost,
  isPlaceholderCost,
  loadSelections,
  loadSpotify,
  picksLogPath,
  stripPlaceholderWrapper,
  targetWeekMonday,
  weekDates,
} from "./common.js";

const ENV_KEYS = [
  "PICKS_LOG_PATH",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isPlaceholderCost / stripPlaceholderWrapper", () => {
  it("is true for wrapped text", () => {
    expect(isPlaceholderCost("*(confirm details)*")).toBe(true);
  });

  it("is true with surrounding whitespace", () => {
    expect(isPlaceholderCost("  *(confirm details)*  ")).toBe(true);
  });

  it("is false for plain text", () => {
    expect(isPlaceholderCost("$15 adv / $20 DOS")).toBe(false);
  });

  it("is false for only one end of the wrapper", () => {
    expect(isPlaceholderCost("*(confirm details")).toBe(false);
    expect(isPlaceholderCost("confirm details)*")).toBe(false);
  });

  it("is false for empty string", () => {
    expect(isPlaceholderCost("")).toBe(false);
  });

  it("strips the markers", () => {
    expect(stripPlaceholderWrapper("*(confirm details)*")).toBe("confirm details");
  });

  it("leaves plain text untouched but trimmed", () => {
    expect(stripPlaceholderWrapper("  $15 adv  ")).toBe("$15 adv");
  });

  it("handles empty input", () => {
    expect(stripPlaceholderWrapper("")).toBe("");
  });
});

describe("isFreeCost", () => {
  it.each(["free", "Free", "FREE", "no cover", "No Cover"])(
    "is true for known synonym %s (case-insensitive)",
    (cost) => {
      expect(isFreeCost(cost)).toBe(true);
    },
  );

  it("is true through a placeholder wrapper", () => {
    expect(isFreeCost("*(free)*")).toBe(true);
  });

  it("is false for a dollar amount", () => {
    expect(isFreeCost("$15 adv / $20 DOS")).toBe(false);
  });

  it("is false for empty cost", () => {
    expect(isFreeCost("")).toBe(false);
  });
});

describe("targetWeekMonday", () => {
  it("rolls to next week when today is already Monday (strictly after, never today)", () => {
    // Per CLAUDE.md: "the Monday immediately following the run date," never the same day.
    expect(targetWeekMonday("2026-06-15")).toBe("2026-06-22");
  });

  it("resolves from mid-week", () => {
    expect(targetWeekMonday("2026-06-17")).toBe("2026-06-22");
  });

  it("rolls from Sunday to the very next day", () => {
    expect(targetWeekMonday("2026-06-21")).toBe("2026-06-22");
  });
});

describe("weekDates", () => {
  it("returns Monday through Sunday in order", () => {
    expect(weekDates("2026-06-22")).toEqual([
      "2026-06-22",
      "2026-06-23",
      "2026-06-24",
      "2026-06-25",
      "2026-06-26",
      "2026-06-27",
      "2026-06-28",
    ]);
  });

  it("spans a month boundary", () => {
    expect(weekDates("2026-06-29").at(-1)).toBe("2026-07-05");
  });
});

describe("picksLogPath", () => {
  it("defaults to DATA_DIR", () => {
    expect(picksLogPath()).toBe(join(DATA_DIR, "event-picks-log.csv"));
  });

  it("treats a relative override as repo-relative", () => {
    process.env["PICKS_LOG_PATH"] = "scratch/test-log.csv";
    expect(picksLogPath()).toBe(join(REPO_ROOT, "scratch", "test-log.csv"));
  });

  it("uses an absolute override verbatim", () => {
    const absPath = join("/tmp", "test-log.csv");
    process.env["PICKS_LOG_PATH"] = absPath;
    expect(picksLogPath()).toBe(absPath);
  });
});

describe("getCalendarCredentials", () => {
  it("throws naming every missing var when all are missing", () => {
    expect(() => getCalendarCredentials()).toThrowError(
      /GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*GOOGLE_REFRESH_TOKEN/,
    );
  });

  it("throws naming only the missing ones", () => {
    process.env["GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["GOOGLE_CLIENT_SECRET"] = "test-client-secret";
    let message = "";
    try {
      getCalendarCredentials();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("GOOGLE_REFRESH_TOKEN");
    expect(message).not.toContain("GOOGLE_CLIENT_ID");
    expect(message).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("succeeds with all vars set", () => {
    process.env["GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["GOOGLE_CLIENT_SECRET"] = "test-client-secret";
    process.env["GOOGLE_REFRESH_TOKEN"] = "test-refresh-token";
    const creds = getCalendarCredentials();
    expect(creds.clientId).toBe("test-client-id");
    expect(creds.clientSecret).toBe("test-client-secret");
    expect(creds.refreshToken).toBe("test-refresh-token");
  });
});

describe("getCalendarId", () => {
  function fakeService(pages: calendar_v3.Schema$CalendarList[]): calendar_v3.Calendar {
    let call = 0;
    return {
      calendarList: {
        list: () => Promise.resolve({ data: pages[call++] }),
      },
    } as unknown as calendar_v3.Calendar;
  }

  it("finds Curated Events by name", async () => {
    const service = fakeService([
      { items: [{ summary: "Other Calendar", id: "other-id" }, { summary: "Curated Events", id: "curated-id" }] },
    ]);
    await expect(getCalendarId(service)).resolves.toBe("curated-id");
  });

  it("paginates across multiple pages", async () => {
    const service = fakeService([
      { items: [{ summary: "Other Calendar", id: "other-id" }], nextPageToken: "page2" },
      { items: [{ summary: "Curated Events", id: "curated-id" }] },
    ]);
    await expect(getCalendarId(service)).resolves.toBe("curated-id");
  });

  it("throws when not found", async () => {
    const service = fakeService([{ items: [{ summary: "Other Calendar", id: "other-id" }] }]);
    await expect(getCalendarId(service)).rejects.toThrowError(/Curated Events/);
  });
});

describe("loadSelections / loadSpotify", () => {
  it("throws a clear error when _selections.json is missing", () => {
    expect(() => loadSelections("/tmp/this-week-in-philly-test-nonexistent")).toThrowError(
      /Selections have not run/,
    );
  });

  it("returns an empty object when _spotify.json is missing", () => {
    // Distinct from loadSelections: a missing _spotify.json means
    // spotify_lookup hasn't run yet, which html_render must tolerate
    // (degrade to plain links), not treat as a hard failure.
    expect(loadSpotify("/tmp/this-week-in-philly-test-nonexistent")).toEqual({});
  });

  it("reads the real committed fixture", () => {
    const weekDir = join(DATA_DIR, "2026-06-22");
    const selections = loadSelections(weekDir) as { week: string; days: unknown[] };
    expect(selections.week).toBe("2026-06-22");
    expect(selections.days).toHaveLength(7);
  });
});
