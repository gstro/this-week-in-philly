// Tests for collectWeek.ts: orchestration and the manifest, with injected
// sources (no network); the sources themselves are covered by
// collectSource.test.ts and the eventParsers tests.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { type Source, SOURCES, collectWeek, partialNote, run } from "./collectWeek.js";
import { type Event, ParseError } from "./eventParsers/index.js";
import { collectRecords, MalformedRecord, makeEvent } from "./eventParsers/base.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

const event = (title: string, date = "2026-10-12"): Event =>
  makeEvent({ title, venue: "V", date, time: "8:00 PM", cost: "", url: "https://example.com", description: "" });

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("partialNote (same text as collect_week.partial_failure_note for failed requests)", () => {
  it("is undefined when nothing was lost", () => {
    expect(partialNote([])).toBeUndefined();
  });

  it("shows a few failures in full", () => {
    expect(partialNote(["a (err)", "b (err)", "c (err)"])).toBe("partial -- 3 request(s) failed: a (err); b (err); c (err)");
  });

  it("caps many failures with a remainder count", () => {
    const failures = Array.from({ length: 7 }, (_, i) => `day-${String(i)} (err)`);
    expect(partialNote(failures)).toBe("partial -- 7 request(s) failed: day-0 (err); day-1 (err); day-2 (err); +4 more");
  });

  it("clips a long skip message", () => {
    expect(partialNote([], ["x".repeat(500)])).toBe(`skipped 1 malformed record(s): ${"x".repeat(200)}...`);
  });

  it("reports skipped malformed records, alone or alongside failures", () => {
    expect(partialNote([], ["bad hour 7:75 pm"])).toBe("skipped 1 malformed record(s): bad hour 7:75 pm");
    expect(partialNote(["x (err)"], ["a", "b", "c", "d"])).toBe(
      "partial -- 1 request(s) failed: x (err) | skipped 4 malformed record(s): a; b; c; +1 more",
    );
  });
});

describe("collectWeek", () => {
  const sources: Source[] = [
    { stem: "zeta", name: "Zeta", collect: () => Promise.resolve({ events: [event("Z")], failed: [] }) },
    { stem: "alpha", name: "Alpha", collect: () => Promise.resolve({ events: [event("A"), event("B")], failed: ["https://a/2 (reset)"] }) },
    { stem: "broken", name: "Broken", collect: () => Promise.reject(new ParseError("no event cards")) },
    {
      stem: "skippy",
      name: "Skippy",
      // A parser skipping one malformed record after an await, as the real collectors do.
      collect: async (): Promise<{ events: Event[]; failed: string[] }> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const events = collectRecords("skippy", ["ok", "bad"], (item) => {
          if (item === "bad") throw new MalformedRecord("impossible time 7:75 pm");
          return event("Fine");
        });
        return { events, failed: [] };
      },
    },
  ];

  it("writes every source file and a sorted manifest, isolating failures", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "collect-week-"));
    const seen: Array<[string, string]> = [];
    const spy: Source = { stem: "window", name: "Window", collect: (start, end) => (seen.push([start, end]), Promise.resolve({ events: [], failed: [] })) };
    const manifest = await collectWeek({ weekStart: "2026-10-12", outRoot, sources: [...sources, spy] });
    const dir = join(outRoot, "2026-10-12");

    expect(seen).toEqual([["2026-10-12", "2026-10-18"]]);
    expect(readdirSync(dir).sort()).toEqual(["_manifest.json", "alpha.json", "broken.json", "skippy.json", "window.json", "zeta.json"]);
    expect(Object.keys(manifest.sources)).toEqual(["alpha", "broken", "skippy", "window", "zeta"]);
    expect(manifest.sources).toEqual({
      alpha: { status: "ok", events: 2, note: "partial -- 1 request(s) failed: https://a/2 (reset)" },
      broken: { status: "failed", reason: "ParseError: no event cards" },
      skippy: { status: "ok", events: 1, note: "skipped 1 malformed record(s): impossible time 7:75 pm" },
      window: { status: "ok", events: 0 },
      zeta: { status: "ok", events: 1 },
    });
    expect(readJson(join(dir, "_manifest.json"))).toEqual(manifest);
    expect(manifest.week).toBe("2026-10-12");
    expect(manifest.run_started).toMatch(TIMESTAMP);
    expect(manifest.run_completed >= manifest.run_started).toBe(true);

    const ok = readJson(join(dir, "alpha.json"));
    expect(Object.keys(ok)).toEqual(["source", "collected_at", "events"]);
    expect(ok.source).toBe("Alpha");
    expect(ok.collected_at).toMatch(TIMESTAMP);
    const failed = readJson(join(dir, "broken.json"));
    expect(Object.keys(failed)).toEqual(["source", "status", "reason", "collected_at"]);
    expect(failed.status).toBe("failed");
  });

  it("every collected_at lies inside the run window at microsecond precision (check_yield's provenance check)", async () => {
    // Fixed-width stamps compare as strings exactly like check_yield.py's datetimes.
    const fast: Source[] = Array.from({ length: 22 }, (_, i) => ({ stem: `s${String(i).padStart(2, "0")}`, name: "S", collect: () => Promise.resolve({ events: [], failed: [] }) }));
    for (let round = 0; round < 50; round++) {
      const outRoot = mkdtempSync(join(tmpdir(), "collect-week-"));
      const manifest = await collectWeek({ weekStart: "2026-10-12", outRoot, sources: fast });
      const stamps = fast.map(({ stem }) => readJson(join(outRoot, "2026-10-12", `${stem}.json`)).collected_at as string);
      expect(new Set(stamps).size).toBe(stamps.length);
      for (const stamp of stamps) {
        expect(stamp > manifest.run_started && stamp < manifest.run_completed, stamp).toBe(true);
      }
    }
  });

  it("--only runs just the named stems", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "collect-week-"));
    const manifest = await collectWeek({ weekStart: "2026-10-12", outRoot, sources, only: new Set(["zeta"]) });
    expect(Object.keys(manifest.sources)).toEqual(["zeta"]);
  });

  it("escapes non-ASCII like Python's json.dump", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "collect-week-"));
    const accented: Source = { stem: "cine", name: "cinéSPEAK", collect: () => Promise.resolve({ events: [], failed: [] }) };
    await collectWeek({ weekStart: "2026-10-12", outRoot, sources: [accented] });
    expect(readFileSync(join(outRoot, "2026-10-12", "cine.json"), "utf8")).toContain('"source": "cin\\u00e9SPEAK"');
  });
});

describe("SOURCES", () => {
  it("covers exactly the stems the Python's last production run wrote", () => {
    const manifest = readJson(join(REPO_ROOT, "data", "2026-10-05", "_manifest.json")) as { sources: Record<string, unknown> };
    expect(SOURCES.map((source) => source.stem).sort()).toEqual(Object.keys(manifest.sources).sort());
  });

  it("has unique stems", () => {
    expect(new Set(SOURCES.map((source) => source.stem)).size).toBe(SOURCES.length);
  });
});

describe("CLI", () => {
  it("rejects a non-Monday, an impossible date, or an unknown option", async () => {
    expect(await run(["--week-start", "2026-10-13"])).toBe(2);
    expect(await run(["--week-start", "2026-02-30"])).toBe(2);
    expect(await run(["--bogus"])).toBe(2);
  });

  it("runs the requested subset", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "collect-week-"));
    // An --only stem that matches no source runs nothing (and fetches nothing).
    expect(await run(["--week-start", "2026-10-12", "--out-root", outRoot, "--only", "none-such"])).toBe(0);
    expect(readJson(join(outRoot, "2026-10-12", "_manifest.json")).sources).toEqual({});
  });
});
