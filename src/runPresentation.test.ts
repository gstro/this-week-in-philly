import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOKUP_TIMEOUT_MS, type RunStep, runPresentation, spawnStep } from "./runPresentation.js";

interface Call {
  script: string;
  args: string[];
  timeoutMs?: number | undefined;
}

/** A RunStep that records calls and answers per script (default 0); a function answer may throw. */
function fake(answers: Record<string, number | (() => number)> = {}): { run: RunStep; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunStep = (script, args, options) => {
    calls.push({ script, args, timeoutMs: options?.timeoutMs });
    const answer = answers[script] ?? 0;
    try {
      return Promise.resolve(typeof answer === "function" ? answer() : answer);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  return { run, calls };
}

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPresentation", () => {
  it("runs lookup, playlist, report, calendar in order with the week dir and the report path", async () => {
    const { run, calls } = fake();
    expect(await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run })).toBe(0);
    expect(calls.map((c) => [c.script, c.args])).toEqual([
      ["spotifyLookup.js", ["data/2026-10-19"]],
      ["spotifyPlaylist.js", ["data/2026-10-19"]],
      ["htmlRender.js", ["data/2026-10-19", join("docs", "weeks", "2026-10-19.html")]],
      ["calendarCreate.js", ["data/2026-10-19"]],
    ]);
    expect(out).toEqual([]);
  });

  it("passes --dry-run to the two mutating steps only, and still looks up and renders for real", async () => {
    const { run, calls } = fake();
    await runPresentation({ weekDir: "data/2026-10-19", dryRun: true, run });
    expect(Object.fromEntries(calls.map((c) => [c.script, c.args.includes("--dry-run")]))).toEqual({
      "spotifyLookup.js": false,
      "spotifyPlaylist.js": true,
      "htmlRender.js": false,
      "calendarCreate.js": true,
    });
  });

  it("limits the lookup to ten minutes and nothing else", async () => {
    const { run, calls } = fake();
    await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run });
    expect(calls.map((c) => c.timeoutMs)).toEqual([LOOKUP_TIMEOUT_MS, undefined, undefined, undefined]);
    expect(LOOKUP_TIMEOUT_MS).toBe(600_000);
  });

  it("a lookup failure warns, skips the playlist, and still renders and writes the calendar", async () => {
    const { run, calls } = fake({ "spotifyLookup.js": 1 });
    expect(await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run })).toBe(0);
    expect(calls.map((c) => c.script)).toEqual(["spotifyLookup.js", "htmlRender.js", "calendarCreate.js"]);
    expect(out).toEqual([expect.stringMatching(/^::warning::spotifyLookup failed \(exit 1\)/)]);
  });

  it("a lookup that throws counts as a failure, not a crash", async () => {
    const { run, calls } = fake({ "spotifyLookup.js": () => { throw new Error("spawn exploded"); } });
    expect(await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run })).toBe(0);
    expect(calls.map((c) => c.script)).toEqual(["spotifyLookup.js", "htmlRender.js", "calendarCreate.js"]);
  });

  it("a playlist failure (nonzero or thrown) warns and the run goes on", async () => {
    for (const answer of [2, (): number => { throw new Error("boom"); }]) {
      out = [];
      const { run, calls } = fake({ "spotifyPlaylist.js": answer });
      expect(await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run })).toBe(0);
      expect(calls.map((c) => c.script)).toEqual(["spotifyLookup.js", "spotifyPlaylist.js", "htmlRender.js", "calendarCreate.js"]);
      expect(out).toEqual([expect.stringMatching(/^::warning::spotifyPlaylist failed/)]);
    }
  });

  it("a report failure stops the run with its exit code, before the calendar", async () => {
    const { run, calls } = fake({ "htmlRender.js": 3 });
    expect(await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run })).toBe(3);
    expect(calls.map((c) => c.script)).toEqual(["spotifyLookup.js", "spotifyPlaylist.js", "htmlRender.js"]);
  });

  it("a calendar failure is the run's exit code", async () => {
    const { run } = fake({ "calendarCreate.js": 1 });
    expect(await runPresentation({ weekDir: "data/2026-10-19", dryRun: false, run })).toBe(1);
  });

  it("a calendar guard refusal (exit 0) is a success", async () => {
    const { run } = fake({ "calendarCreate.js": 0 });
    expect(await runPresentation({ weekDir: "data/2026-10-12", dryRun: false, run })).toBe(0);
  });

  it("accepts a trailing slash on the week dir", async () => {
    const { run, calls } = fake();
    await runPresentation({ weekDir: "data/2026-10-19/", dryRun: false, run });
    expect(calls[2]?.args[1]).toBe(join("docs", "weeks", "2026-10-19.html"));
  });
});

describe("spawnStep", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-presentation-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  it("resolves the script's exit code and passes its arguments", async () => {
    const path = script("exit.cjs", "process.exit(Number(process.argv[2]))");
    expect(await spawnStep(path, ["0"])).toBe(0);
    expect(await spawnStep(path, ["3"])).toBe(3);
  });

  it("is nonzero for a script that does not exist", async () => {
    expect(await spawnStep(join(dir, "missing.cjs"), [])).not.toBe(0);
  });

  it("kills a script that outlives its timeout and reports failure", async () => {
    const path = script("hang.cjs", "setTimeout(() => {}, 60000)");
    expect(await spawnStep(path, [], { timeoutMs: 200 })).not.toBe(0);
  });
});
