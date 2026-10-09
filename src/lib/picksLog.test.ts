/**
 * Tests for lib/picksLog.ts: the picks-log CSV reader/writer shared by
 * csvLog.ts and attendanceCheck.ts. No Python counterpart (Python used the
 * csv module directly); the strict-read cases are the inputs Python handled
 * badly (see the module header).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PICKS_LOG_COLUMNS } from "../common.js";
import { type PicksLogRow, PicksLogError, formatPicksLog, parsePicksLog, writeFileAtomic } from "./picksLog.js";

const HEADER = PICKS_LOG_COLUMNS.join(",");
const ROW = "Philadelphia,2026-06-15,Monday,2026-06-15,A,V,music,S,1,free,,,";

function row(overrides: Partial<PicksLogRow> = {}): PicksLogRow {
  const blank = Object.fromEntries(PICKS_LOG_COLUMNS.map((c) => [c, ""])) as PicksLogRow;
  return { ...blank, city: "Philadelphia", week_of: "2026-06-15", title: "A", ...overrides };
}

describe("parsePicksLog", () => {
  it("reads rows keyed by column, padding short rows and skipping blank lines", () => {
    const rows = parsePicksLog(`${HEADER}\n${ROW}\n\nPhiladelphia,2026-06-15,Monday\n`, "log.csv");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "A", rank: "1", attended: "" });
    expect(rows[1]).toMatchObject({ day: "Monday", title: "", attended: "" });
  });

  it("strips a UTF-8 BOM", () => {
    expect(parsePicksLog(`\ufeff${HEADER}\r\n${ROW}\r\n`, "log.csv")).toHaveLength(1);
  });

  it.each([
    ["an empty file", "", /is empty \(no header row\)/],
    ["a blank first line", `\r\n${HEADER}\r\n${ROW}\r\n`, /first line is blank/],
    ["a header without attended", "city,week_of,title\r\n", /missing day, date, venue.*attended/],
    ["an unknown column", `${HEADER},notes\r\n`, /unknown "notes"/],
    ["a duplicated column", `${HEADER},title\r\n`, /duplicated title/],
    ["columns out of order", `week_of,city,${PICKS_LOG_COLUMNS.slice(2).join(",")}\r\n`, /wrong order/],
    ["a row with extra fields", `${HEADER}\r\n${ROW}\r\n${ROW},extra\r\n`, /record 3 has 14 fields; the header has 13/],
    ["malformed quoting", `${HEADER}\r\nPhiladelphia,"b"c\r\n`, /Invalid Closing Quote/],
    ["an unclosed quote", `${HEADER}\r\nPhiladelphia,"open\r\n`, /Quote Not Closed/],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parsePicksLog(text, "log.csv")).toThrow(PicksLogError);
    expect(() => parsePicksLog(text, "log.csv")).toThrow(message);
  });
});

describe("formatPicksLog", () => {
  it("writes the header and rows in column order with \\r\\n, quoting only when needed", () => {
    const text = formatPicksLog([row({ title: 'a, "b"', venue: "two\nlines", source: "cr\ronly" })]);
    expect(text).toBe(
      `${HEADER}\r\nPhiladelphia,2026-06-15,,,"a, ""b""","two\nlines",,"cr\ronly",,,,,\r\n`,
    );
  });

  it("omits the header on request and writes nothing for no rows", () => {
    expect(formatPicksLog([], { header: false })).toBe("");
    expect(formatPicksLog([])).toBe(`${HEADER}\r\n`);
  });

  it("round-trips through parsePicksLog", () => {
    const rows = [row({ title: "Café — “Noir” \"live\", 2am\r\n" }), row({ title: "B", attended: "true" })];
    expect(parsePicksLog(formatPicksLog(rows), "log.csv")).toEqual(rows);
  });
});

describe("writeFileAtomic", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the file and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "picks-"));
    dirs.push(dir);
    const path = join(dir, "log.csv");
    writeFileSync(path, "old");
    writeFileAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["log.csv"]);
  });

  it("leaves the original intact and cleans up when the write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "picks-"));
    dirs.push(dir);
    const path = join(dir, "missing-subdir", "log.csv");
    expect(() => writeFileAtomic(path, "new")).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
