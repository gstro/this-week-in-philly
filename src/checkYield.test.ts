/**
 * Port of tests/test_check_yield.py.
 *
 * Points at the same fixture the Python suite uses --
 * tests/fixtures/check_yield/fabricated-2026-07-27/ is the real, committed
 * data/2026-07-27/ directory (the actual incident where 17 source files
 * share one fabricated collected_at timestamp), not a hand-built fixture, so
 * this test fails if that specific incident's signature ever stops being
 * detected. Everything else is small inline data -- the pure check
 * functions don't need disk I/O to exercise their logic.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Manifest,
  type SourceFile,
  NON_SOURCE_FILES,
  checkManifestFileAgreement,
  checkNonDestructive,
  checkProvenance,
  checkYieldFloor,
  collectIssues,
  formatReport,
} from "./checkYield.js";

const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures", "check_yield");

function loadWeekDir(weekDir: string): {
  manifest: Manifest;
  sourceFiles: Record<string, SourceFile>;
  filesOnDisk: Set<string>;
} {
  const manifest = JSON.parse(readFileSync(join(weekDir, "_manifest.json"), "utf8")) as Manifest;
  const sourceFiles: Record<string, SourceFile> = {};
  const filesOnDisk = new Set<string>();
  for (const name of readdirSync(weekDir)) {
    if (!name.endsWith(".json")) continue;
    filesOnDisk.add(name);
    if (name === "_manifest.json") continue;
    sourceFiles[name.slice(0, -".json".length)] = JSON.parse(readFileSync(join(weekDir, name), "utf8")) as SourceFile;
  }
  return { manifest, sourceFiles, filesOnDisk };
}

describe("real incident regression: the fabricated 2026-07-27 week", () => {
  it("trips the provenance check", () => {
    const { manifest, sourceFiles } = loadWeekDir(join(FIXTURES, "fabricated-2026-07-27"));
    const issues = checkProvenance(manifest, sourceFiles);

    const provenanceIssue = issues.find((i) => i.source === null && i.message.includes("share the identical"));
    expect(provenanceIssue).toBeDefined();
    for (const source of [
      "billy-penn",
      "cinespeak",
      "do215",
      "lightbox-film-center",
      "meetup-ai-philly",
      "meetup-code-coffee",
      "meetup-dc215",
      "meetup-horror",
      "meetup-owasp",
      "meetup-philly-film-club",
      "meetup-philly-hardware",
      "meetup-tech-in-motion",
      "philadelphia-citizen",
      "philly-shows",
      "phillygoth",
      "songkick",
      "wxpn",
    ]) {
      expect(provenanceIssue!.message).toContain(source);
    }
  });

  it("exits nonzero via collectIssues", () => {
    const { manifest, sourceFiles, filesOnDisk } = loadWeekDir(join(FIXTURES, "fabricated-2026-07-27"));
    const expected = { sources: {}, _meta: {} }; // isolate provenance signal; no yield-floor noise
    const issues = collectIssues(manifest, sourceFiles, filesOnDisk, expected);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.check === "provenance")).toBe(true);
  });

  it("produces a nonempty report", () => {
    const { manifest, sourceFiles, filesOnDisk } = loadWeekDir(join(FIXTURES, "fabricated-2026-07-27"));
    const issues = collectIssues(manifest, sourceFiles, filesOnDisk, { sources: {}, _meta: {} });
    const report = formatReport(issues, manifest.week!);
    expect(report).toContain("PROVENANCE");
    expect(report).toContain("issue(s) found");
  });
});

describe("provenance: unit-level", () => {
  it("passes when timestamps are distinct", () => {
    const manifest = { run_started: "2026-08-03T02:00:00", run_completed: "2026-08-03T02:30:00" };
    const sourceFiles = {
      a: { collected_at: "2026-08-03T02:05:00" },
      b: { collected_at: "2026-08-03T02:06:00" },
    };
    expect(checkProvenance(manifest, sourceFiles)).toEqual([]);
  });

  it("passes when the run window is naive UTC and sources are offset-aware", () => {
    // Real manifests write run_started/run_completed as naive strings that are
    // still UTC in fact (no +00:00 suffix), while collected_at is always
    // offset-aware UTC. Comparing them must normalize to UTC, not the local
    // machine's timezone -- this is a real bug caught against real data
    // (data/2026-07-20/_manifest.json), where every source false-flagged
    // before the fix.
    const manifest = { run_started: "2026-07-23T01:32:00", run_completed: "2026-07-23T01:40:44.675148+00:00" };
    const sourceFiles = { do215: { collected_at: "2026-07-23T01:40:31.672658+00:00" } };
    expect(checkProvenance(manifest, sourceFiles)).toEqual([]);
  });

  it("flags a timestamp outside the run window", () => {
    const manifest = { run_started: "2026-08-03T02:00:00", run_completed: "2026-08-03T02:30:00" };
    const sourceFiles = { a: { collected_at: "2026-08-01T00:00:00" } };
    const issues = checkProvenance(manifest, sourceFiles);
    expect(issues.length).toBe(1);
    expect(issues[0]!.source).toBe("a");
    expect(issues[0]!.message).toContain("outside this run's");
  });

  it("skips the window check entirely when run_started/run_completed are unparseable", () => {
    // Mirrors Python's `except ValueError` at the window-parse site: a
    // malformed run window disables the window check, but must not throw.
    const manifest = { run_started: "not-a-date", run_completed: "2026-08-03T02:30:00" };
    const sourceFiles = { a: { collected_at: "2026-08-01T00:00:00" } };
    expect(checkProvenance(manifest, sourceFiles)).toEqual([]);
  });

  it("skips a source whose own collected_at is unparseable, rather than flagging it", () => {
    // Mirrors Python's `except ValueError` at the per-source parse site.
    const manifest = { run_started: "2026-08-03T02:00:00", run_completed: "2026-08-03T02:30:00" };
    const sourceFiles = { a: { collected_at: "garbage" } };
    expect(checkProvenance(manifest, sourceFiles)).toEqual([]);
  });
});

describe("yield floor", () => {
  it("flags an ok source below its documented minimum", () => {
    const manifest = { sources: { do215: { status: "ok", events: 0 } } };
    const expected = { sources: { do215: { min_expected: 4 } }, _meta: {} };
    const issues = checkYieldFloor(manifest, expected);
    expect(issues.length).toBe(1);
    expect(issues[0]!.source).toBe("do215");
  });

  it("does not flag a source with a zero floor", () => {
    // Sources documented as genuinely-quiet (min_expected: 0) never trip this
    // check -- exactly the meetup-owasp / philly-shows case, so a real quiet
    // week isn't cried wolf on.
    const manifest = { sources: { "meetup-owasp": { status: "ok", events: 0 } } };
    const expected = { sources: { "meetup-owasp": { min_expected: 0 } }, _meta: {} };
    expect(checkYieldFloor(manifest, expected)).toEqual([]);
  });

  it("ignores failed sources", () => {
    // A source that failed outright reports its own failure -- not a silent-zero case.
    const manifest = { sources: { "philadelphia-film-society": { status: "failed", reason: "timeout" } } };
    const expected = { sources: { "philadelphia-film-society": { min_expected: 4 } }, _meta: {} };
    expect(checkYieldFloor(manifest, expected)).toEqual([]);
  });

  it("flags a low aggregate even if no single source trips", () => {
    const manifest = { sources: { a: { status: "ok", events: 5 }, b: { status: "ok", events: 5 } } };
    const expected = { sources: {}, _meta: { total_floor: 45 } };
    const issues = checkYieldFloor(manifest, expected);
    expect(issues.length).toBe(1);
    expect(issues[0]!.source).toBeNull();
    expect(issues[0]!.message).toContain("whole-run floor");
  });
});

describe("manifest/file agreement", () => {
  it("flags a count mismatch", () => {
    const manifest = { sources: { do215: { status: "ok", events: 3 } } };
    const sourceFiles = { do215: { events: [{ title: "x" }] } };
    const issues = checkManifestFileAgreement(manifest, sourceFiles, new Set(["do215.json"]));
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("3 events but the source file actually contains 1");
  });

  it("flags an orphaned file with no manifest entry", () => {
    const manifest = { sources: {} };
    const sourceFiles = { do215: { events: [] } };
    const issues = checkManifestFileAgreement(manifest, sourceFiles, new Set(["do215.json"]));
    expect(issues.length).toBe(1);
    expect(issues[0]!.source).toBe("do215");
    expect(issues[0]!.message).toContain("no manifest entry");
  });

  it("flags a missing file", () => {
    const manifest = { sources: { do215: { status: "ok", events: 3 } } };
    const issues = checkManifestFileAgreement(manifest, {}, new Set());
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("no source file found");
  });

  it("passes the clean case", () => {
    const manifest = { sources: { do215: { status: "ok", events: 1 } } };
    const sourceFiles = { do215: { events: [{ title: "x" }] } };
    expect(checkManifestFileAgreement(manifest, sourceFiles, new Set(["do215.json"]))).toEqual([]);
  });

  it("exempts every derived artifact", () => {
    // Derived outputs live in the week directory but have no manifest entry,
    // so each must be exempt or it reads as an orphaned source file. This is
    // a real regression: _recent_picks.json was added without the exemption
    // and made check_yield.py exit 1 against a completed week -- which
    // collection-check.yml re-runs on any push touching _manifest.json, the
    // same commit the sidecar ships in.
    const manifest = { sources: { do215: { status: "ok", events: 1 } } };
    const sourceFiles = { do215: { events: [{ title: "x" }] } };
    const onDisk = new Set(["do215.json", ...NON_SOURCE_FILES]);
    expect(checkManifestFileAgreement(manifest, sourceFiles, onDisk)).toEqual([]);
  });
});

describe("non-destructive re-collection (the 71c6645 incident)", () => {
  it("flags a regression to zero", () => {
    // Reproduces the real 71c6645 incident: do215 had 11 real events
    // committed, a re-collection wrote 0, and the empty file was committed
    // over the real data.
    const prior = { do215: { events: Array.from({ length: 11 }, (_, i) => ({ title: `Show ${String(i)}` })) } };
    const current = { do215: { events: [] } };
    const issues = checkNonDestructive(current, prior);
    expect(issues.length).toBe(1);
    expect(issues[0]!.source).toBe("do215");
    expect(issues[0]!.message).toContain("erase real data");
  });

  it("allows a genuinely empty source to stay empty", () => {
    const prior = { "meetup-owasp": { events: [] } };
    const current = { "meetup-owasp": { events: [] } };
    expect(checkNonDestructive(current, prior)).toEqual([]);
  });

  it("allows a non-regressive change", () => {
    const prior = { do215: { events: [{ title: "a" }] } };
    const current = { do215: { events: [{ title: "a" }, { title: "b" }] } };
    expect(checkNonDestructive(current, prior)).toEqual([]);
  });

  it("is skipped when no prior state is given", () => {
    const manifest = { sources: { do215: { status: "ok", events: 0 } } };
    const sourceFiles = { do215: { events: [] } };
    const expected = { sources: { do215: { min_expected: 0 } }, _meta: {} };
    // priorSourceFiles omitted (the default) means "no prior git ref to
    // compare" -- must not throw, and must not run the non_destructive check.
    const issues = collectIssues(manifest, sourceFiles, new Set(["do215.json"]), expected);
    expect(issues).toEqual([]);
  });
});

describe("real expected_yield.json sanity", () => {
  it("is well-formed and exempts known quiet sources", () => {
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "data", "expected_yield.json"), "utf8"),
    ) as { sources: Record<string, { min_expected: unknown }>; _meta: unknown };

    expect(expected.sources).toBeDefined();
    expect(expected._meta).toBeDefined();
    for (const [source, config] of Object.entries(expected.sources)) {
      expect(typeof config.min_expected, source).toBe("number");
      expect(config.min_expected as number, source).toBeGreaterThanOrEqual(0);
    }

    for (const quietSource of ["meetup-owasp", "meetup-ai-philly", "meetup-philly-film-club", "philly-shows"]) {
      expect(expected.sources[quietSource]!.min_expected).toBe(0);
    }
  });
});
