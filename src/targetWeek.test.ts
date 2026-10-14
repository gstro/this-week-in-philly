import { describe, expect, it, vi } from "vitest";
import { run } from "./targetWeek.js";

describe("targetWeek run", () => {
  const printed = (argv: string[]): { code: number; lines: string[] } => {
    const lines: string[] = [];
    return { code: run(argv, (line) => void lines.push(line)), lines };
  };

  it.each([
    ["2026-10-18", "2026-10-19"], // Sunday: the Monday after
    ["2026-10-19", "2026-10-26"], // Monday: next week's, never today's
    ["2026-10-24", "2026-10-26"], // Saturday
    ["2026-12-27", "2026-12-28"], // across the year end
  ])("%s -> %s", (today, monday) => {
    expect(printed([today])).toEqual({ code: 0, lines: [monday] });
  });

  it("defaults to the real date", () => {
    const result = printed([]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects a malformed date or extra arguments", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(run(["tomorrow"], () => undefined)).toBe(2);
    expect(run(["2026-10-18", "x"], () => undefined)).toBe(2);
    error.mockRestore();
  });
});
