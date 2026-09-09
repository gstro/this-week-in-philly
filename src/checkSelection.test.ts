import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecentWeeks } from "./checkSelection.js";
import { writeJson } from "./lib/json.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "twip-check-selection-"));
}

function weekOnDisk(root: string, name: string, { withSelections = true } = {}): void {
  const dir = join(root, name);
  mkdirSync(dir);
  if (withSelections) {
    const days = [{ date: name, day_name: "Monday", top3: [], honorable_mentions: [], events: [] }];
    writeFileSync(join(dir, "_selections.json"), writeJson({ week: name, days }));
  }
}

describe("loadRecentWeeks", () => {
  it("returns the most recent priors, newest first", () => {
    const root = makeTmpDir();
    for (const name of ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]) {
      weekOnDisk(root, name);
    }
    const weeks = loadRecentWeeks(join(root, "2026-08-24"), 2) as { week: string }[];
    expect(weeks.map((w) => w.week)).toEqual(["2026-08-17", "2026-08-10"]);
  });

  it("skips Collection-only weeks (no _selections.json)", () => {
    const root = makeTmpDir();
    weekOnDisk(root, "2026-07-13");
    weekOnDisk(root, "2026-07-20", { withSelections: false });
    weekOnDisk(root, "2026-07-27", { withSelections: false });
    weekOnDisk(root, "2026-08-03");
    const weeks = loadRecentWeeks(join(root, "2026-08-03"), 3) as { week: string }[];
    expect(weeks.map((w) => w.week)).toEqual(["2026-07-13"]);
  });

  it("returns empty for the earliest week", () => {
    const root = makeTmpDir();
    weekOnDisk(root, "2026-06-22");
    expect(loadRecentWeeks(join(root, "2026-06-22"))).toEqual([]);
  });

  it("never looks forward", () => {
    const root = makeTmpDir();
    weekOnDisk(root, "2026-08-17");
    weekOnDisk(root, "2026-08-24");
    expect(loadRecentWeeks(join(root, "2026-08-17"))).toEqual([]);
  });
});
