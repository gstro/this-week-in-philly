/**
 * scripts/ci/pipeline.sh (the engine dispatcher the workflows call) and
 * scripts/runner.sh (the Python Presentation step it dispatches to), driven
 * with stub `node`/`python`/`python3` executables that log their arguments
 * and can be told to fail. Nothing here runs a real pipeline step.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./common.js";

const PIPELINE = join(REPO_ROOT, "scripts", "ci", "pipeline.sh");
let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipeline-sh-"));
  log = join(dir, "calls.log");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["node", "python", "python3"]) {
    const path = join(bin, name);
    // Logs "<name> <args>"; fails when any argument contains $STUB_FAIL.
    writeFileSync(
      path,
      `#!/bin/bash\necho "$(basename "$0") $*" >> "$STUB_LOG"\ncase "$*" in *"\${STUB_FAIL:-@@never@@}"*) exit 1 ;; esac\n`,
    );
    chmodSync(path, 0o755);
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pipeline(args: string[], env: Record<string, string> = {}): { code: number; calls: string[]; out: string } {
  rmSync(log, { force: true }); // each call reports only its own steps
  const result = spawnSync("/bin/bash", [PIPELINE, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, STUB_LOG: log, ...env },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    /* no step ran */
  }
  return { code: result.status ?? -1, calls, out: result.stdout + result.stderr };
}

const WEEK = "data/2026-10-19";

describe("pipeline.sh engine dispatch", () => {
  it.each([
    ["collect", ["--week-start", "2026-10-19"], "collectWeek.js", "collect_week.py"],
    ["check-yield", [WEEK, "--check-against-ref", "abc"], "checkYield.js", "check_yield.py"],
    ["prepare-selection", [WEEK, "--split-by-day"], "prepareSelectionInput.js", "prepare_selection_input.py"],
    ["merge-selections", [WEEK], "mergeSelections.js", "merge_selections.py"],
    ["check-selection", [WEEK], "checkSelection.js", "check_selection.py"],
  ])("%s runs the TS CLI under ENGINE=ts and the Python script otherwise, args unchanged", (step, args, ts, py) => {
    expect(pipeline([step, ...args], { ENGINE: "ts" })).toMatchObject({ code: 0, calls: [`node dist/${ts} ${args.join(" ")}`] });
    expect(pipeline([step, ...args], { ENGINE: "python" })).toMatchObject({ code: 0, calls: [`python scripts/${py} ${args.join(" ")}`] });
    expect(pipeline([step, ...args]).calls).toEqual([`python scripts/${py} ${args.join(" ")}`]); // the default
  });

  it("target-week", () => {
    expect(pipeline(["target-week"], { ENGINE: "ts" }).calls).toEqual(["node dist/targetWeek.js"]);
    const [call] = pipeline(["target-week"]).calls;
    expect(call).toMatch(/^python3 -c .*target_week_monday/);
  });

  it("present under ts runs runPresentation with the week and the dry-run flag", () => {
    expect(pipeline(["present", WEEK], { ENGINE: "ts" }).calls).toEqual([`node dist/runPresentation.js ${WEEK}`]);
    expect(pipeline(["present", WEEK, "--dry-run"], { ENGINE: "ts" }).calls).toEqual([`node dist/runPresentation.js ${WEEK} --dry-run`]);
  });

  it("propagates the step's exit code", () => {
    expect(pipeline(["check-yield", WEEK], { ENGINE: "ts", STUB_FAIL: "checkYield" }).code).toBe(1);
  });

  it("reads the engine case-insensitively, as Actions compares it", () => {
    expect(pipeline(["merge-selections", WEEK], { ENGINE: "TS" }).calls).toEqual([`node dist/mergeSelections.js ${WEEK}`]);
  });

  it("rejects an unknown engine, an unknown step, and no step", () => {
    expect(pipeline(["collect"], { ENGINE: "rust" })).toMatchObject({ code: 2, calls: [] });
    expect(pipeline(["frobnicate"])).toMatchObject({ code: 2, calls: [] });
    expect(pipeline([])).toMatchObject({ code: 2, calls: [] });
  });
});

describe("runner.sh (the Python Presentation step)", () => {
  const html = "docs/weeks/2026-10-19.html";
  const present = (extra: string[] = [], env: Record<string, string> = {}): ReturnType<typeof pipeline> =>
    pipeline(["present", WEEK, ...extra], env);

  it("runs lookup, playlist, report, calendar in order", () => {
    expect(present()).toMatchObject({
      code: 0,
      calls: [
        `python scripts/spotify_lookup.py ${WEEK}`,
        `python scripts/spotify_playlist.py ${WEEK}`,
        `python scripts/html_render.py ${WEEK} ${html}`,
        `python scripts/calendar_create.py ${WEEK}`,
      ],
    });
  });

  it("--dry-run reaches only the playlist and the calendar", () => {
    expect(present(["--dry-run"]).calls).toEqual([
      `python scripts/spotify_lookup.py ${WEEK}`,
      `python scripts/spotify_playlist.py ${WEEK} --dry-run`,
      `python scripts/html_render.py ${WEEK} ${html}`,
      `python scripts/calendar_create.py ${WEEK} --dry-run`,
    ]);
  });

  it("a lookup failure warns, skips the playlist, and still renders and writes the calendar", () => {
    const result = present([], { STUB_FAIL: "spotify_lookup" });
    expect(result.code).toBe(0);
    expect(result.out).toContain("::warning::spotify_lookup failed");
    expect(result.calls.map((c) => c.split(" ")[1])).toEqual([
      "scripts/spotify_lookup.py",
      "scripts/html_render.py",
      "scripts/calendar_create.py",
    ]);
  });

  it("a playlist failure warns and the run goes on", () => {
    const result = present([], { STUB_FAIL: "spotify_playlist" });
    expect(result.code).toBe(0);
    expect(result.out).toContain("::warning::spotify_playlist failed");
    expect(result.calls).toHaveLength(4);
  });

  it("a report failure is fatal and the calendar is not touched", () => {
    const result = present([], { STUB_FAIL: "html_render" });
    expect(result.code).not.toBe(0);
    expect(result.calls.some((c) => c.includes("calendar_create"))).toBe(false);
  });

  it("a calendar failure is fatal", () => {
    expect(present([], { STUB_FAIL: "calendar_create" }).code).not.toBe(0);
  });
});
