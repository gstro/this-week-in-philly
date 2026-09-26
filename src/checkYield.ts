#!/usr/bin/env node
/**
 * Port of scripts/check_yield.py -- guards against Collection silently
 * reporting zero events as success.
 *
 * Confirmed live (2026-07-22/23, week of 2026-07-27): 17 of the week's 29
 * source files carried the *exact same* microsecond `collected_at`
 * timestamp, each with an empty `events` array and `status: ok` in the
 * manifest -- one write, copied, not seventeen independent fetches. See
 * tests/fixtures/check_yield/fabricated-2026-07-27/ (the real committed
 * incident) for the regression this guards.
 *
 * Three checks, run independently (a source failing one doesn't skip the
 * others): provenance (duplicate/out-of-window `collected_at`), yield floor
 * (an `ok` source below its documented historical minimum,
 * data/expected_yield.json), and manifest/file agreement (every manifest
 * source has a file, every file's event count matches, no orphaned files).
 * A fourth, optional check (--check-against-ref) compares this run's files
 * against a prior git ref's committed version and flags a regression from
 * real events to zero -- the guard for the 71c6645 incident.
 *
 * Divergences from the Python, all intentional:
 *
 * - parseTimestamp: Python's `datetime.fromisoformat` treats a naive string
 *   (no offset) as UTC-in-fact per this repo's manifests (naive
 *   run_started/run_completed alongside offset-aware collected_at from the
 *   same run -- see the "naive UTC" test below). `new Date("...no
 *   offset...")` in JS parses as *local time* instead, which would silently
 *   introduce a multi-hour skew on any non-UTC machine while looking correct
 *   in a UTC CI container. This appends a literal "Z" to any string that has
 *   no offset suffix before calling Date.parse, so both forms resolve to the
 *   same UTC instant Python's astimezone(UTC) does. Returns null (not NaN)
 *   on an unparseable string, mirroring Python's `except ValueError`.
 * - The duplicate-timestamp check keys on the *raw string*, not the parsed
 *   epoch millis -- deliberately not normalized, because collected_at carries
 *   microsecond precision that Date.parse truncates to milliseconds, and
 *   normalizing first would start collapsing genuinely distinct timestamps.
 * - gitShowJson: Python's `subprocess.run(..., check=False)` returns a
 *   nonzero exit for "path doesn't exist at that ref" without raising --
 *   handled by checking returncode. Node's execFileSync *throws* on a
 *   nonzero exit, so this wraps it in try/catch and returns null instead --
 *   without that, --check-against-ref would crash on exactly the normal
 *   "new source" / "new week" case it exists to tolerate. Also passes an
 *   explicit maxBuffer (Node's 1MB default is plausibly under a real
 *   source file -- expected_yield.json's own notes cite 467 events for
 *   do215 in one real week).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DATA_DIR, REPO_ROOT, loadJson } from "./common.js";

// Manifest/candidates/selections/spotify files live alongside source files in
// the same week directory but aren't sources themselves. See
// check_yield.py's module-level comment for why each one is exempt from the
// orphan-file check below (all derived, all regenerable, none carry a
// manifest entry of their own).
export const NON_SOURCE_FILES = new Set([
  "_manifest.json",
  "_candidates.json",
  "_recent_picks.json",
  "_selection_annotations.json",
  "_selections.json",
  "_spotify.json",
]);

export interface Issue {
  check: string;
  source: string | null;
  message: string;
}

export interface ManifestSourceResult {
  status?: string;
  events?: number;
  reason?: string;
}

export interface Manifest {
  week?: string;
  run_started?: string;
  run_completed?: string;
  sources?: Record<string, ManifestSourceResult>;
}

export interface SourceFile {
  collected_at?: string;
  events?: unknown[];
}

export interface ExpectedYield {
  sources?: Record<string, { min_expected?: number }>;
  _meta?: { total_floor?: number };
}

/**
 * Mirrors Python's str repr(): single-quoted by default, switching to
 * double quotes when the string contains a single quote but no double
 * quote. Same helper as checkSelection.ts's pyRepr -- duplicated rather than
 * shared, matching that file's own choice to keep it local.
 */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/\\/g, "\\\\").split(quote).join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** Epoch millis for an ISO-ish timestamp, normalized to UTC; null if unparseable. See module docstring. */
function parseTimestamp(value: string): number | null {
  const hasOffset = /Z$|[+-]\d{2}:\d{2}$/.test(value);
  const ms = Date.parse(hasOffset ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function checkProvenance(manifest: Manifest, sourceFiles: Record<string, SourceFile>): Issue[] {
  const issues: Issue[] = [];

  const seenTimestamps = new Map<string, string[]>();
  for (const [source, content] of Object.entries(sourceFiles)) {
    const ts = content.collected_at;
    if (!ts) continue;
    const list = seenTimestamps.get(ts);
    if (list) list.push(source);
    else seenTimestamps.set(ts, [source]);
  }

  for (const [ts, sources] of seenTimestamps) {
    if (sources.length > 1) {
      issues.push({
        check: "provenance",
        source: null,
        message:
          `${String(sources.length)} source files share the identical collected_at ` +
          `timestamp ${pyRepr(ts)} -- not independent fetches: ${[...sources].sort().join(", ")}`,
      });
    }
  }

  const runStarted = manifest.run_started;
  const runCompleted = manifest.run_completed;
  if (runStarted && runCompleted) {
    const started = parseTimestamp(runStarted);
    const completed = parseTimestamp(runCompleted);
    if (started !== null && completed !== null) {
      for (const [source, content] of Object.entries(sourceFiles)) {
        const ts = content.collected_at;
        if (!ts) continue;
        const collected = parseTimestamp(ts);
        if (collected === null) continue;
        if (!(started <= collected && collected <= completed)) {
          issues.push({
            check: "provenance",
            source,
            message: `collected_at ${pyRepr(ts)} falls outside this run's [${runStarted}, ${runCompleted}] window`,
          });
        }
      }
    }
  }

  return issues;
}

export function checkYieldFloor(manifest: Manifest, expected: ExpectedYield): Issue[] {
  const issues: Issue[] = [];
  const sourcesExpected = expected.sources ?? {};

  for (const [source, result] of Object.entries(manifest.sources ?? {})) {
    if (result.status !== "ok") continue;
    const events = result.events ?? 0;
    const floor = sourcesExpected[source]?.min_expected ?? 0;
    if (floor > 0 && events < floor) {
      issues.push({
        check: "yield_floor",
        source,
        message: `wrote ${String(events)} events, below documented floor ${String(floor)} (data/expected_yield.json)`,
      });
    }
  }

  const totalFloor = expected._meta?.total_floor ?? 0;
  const totalEvents = Object.values(manifest.sources ?? {}).reduce((sum, r) => sum + (r.events ?? 0), 0);
  if (totalFloor && totalEvents < totalFloor) {
    issues.push({
      check: "yield_floor",
      source: null,
      message:
        `total events collected (${String(totalEvents)}) is below the ` +
        `whole-run floor (${String(totalFloor)}) -- the run as a whole looks suspect ` +
        "even if no single source tripped its own floor",
    });
  }

  return issues;
}

export function checkManifestFileAgreement(
  manifest: Manifest,
  sourceFiles: Record<string, SourceFile>,
  filesOnDisk: Set<string>,
): Issue[] {
  const issues: Issue[] = [];
  const manifestSources = manifest.sources ?? {};

  for (const [source, result] of Object.entries(manifestSources)) {
    if (!(source in sourceFiles)) {
      issues.push({ check: "file_agreement", source, message: "listed in manifest but no source file found on disk" });
      continue;
    }
    if (result.status !== "ok") continue;
    const fileEvents = sourceFiles[source]!.events ?? [];
    const manifestEvents = result.events ?? 0;
    if (fileEvents.length !== manifestEvents) {
      issues.push({
        check: "file_agreement",
        source,
        message:
          `manifest claims ${String(manifestEvents)} events but the source file ` +
          `actually contains ${String(fileEvents.length)}`,
      });
    }
  }

  const manifestFilenames = new Set(Object.keys(manifestSources).map((source) => `${source}.json`));
  const orphaned = [...filesOnDisk]
    .filter((filename) => !manifestFilenames.has(filename) && !NON_SOURCE_FILES.has(filename))
    .sort();
  for (const filename of orphaned) {
    issues.push({
      check: "file_agreement",
      source: filename.slice(0, -".json".length),
      message: "source file exists on disk but has no manifest entry",
    });
  }

  return issues;
}

export function checkNonDestructive(
  sourceFiles: Record<string, SourceFile>,
  priorSourceFiles: Record<string, SourceFile>,
): Issue[] {
  const issues: Issue[] = [];
  for (const [source, prior] of Object.entries(priorSourceFiles)) {
    const priorEvents = (prior.events ?? []).length;
    if (priorEvents === 0) continue;
    const current = sourceFiles[source];
    const currentEvents = current ? (current.events ?? []).length : 0;
    if (currentEvents === 0) {
      issues.push({
        check: "non_destructive",
        source,
        message:
          `this run wrote 0 events, but the committed prior version had ` +
          `${String(priorEvents)} -- a re-collection must not silently erase real data`,
      });
    }
  }
  return issues;
}

/**
 * `priorSourceFiles` is optional so every existing caller keeps working; the
 * non-destructive-recollection check simply doesn't run without it.
 */
export function collectIssues(
  manifest: Manifest,
  sourceFiles: Record<string, SourceFile>,
  filesOnDisk: Set<string>,
  expected: ExpectedYield,
  priorSourceFiles?: Record<string, SourceFile> | null,
): Issue[] {
  const issues = [
    ...checkProvenance(manifest, sourceFiles),
    ...checkYieldFloor(manifest, expected),
    ...checkManifestFileAgreement(manifest, sourceFiles, filesOnDisk),
  ];
  if (priorSourceFiles != null) {
    issues.push(...checkNonDestructive(sourceFiles, priorSourceFiles));
  }
  return issues;
}

function loadWeekDir(weekDir: string): {
  manifest: Manifest;
  sourceFiles: Record<string, SourceFile>;
  filesOnDisk: Set<string>;
} {
  const manifestPath = join(weekDir, "_manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No _manifest.json in ${weekDir}`);
  }
  const manifest = loadJson(manifestPath) as Manifest;

  const sourceFiles: Record<string, SourceFile> = {};
  const filesOnDisk = new Set<string>();
  for (const name of readdirSync(weekDir)) {
    if (!name.endsWith(".json")) continue;
    filesOnDisk.add(name);
    if (NON_SOURCE_FILES.has(name)) continue;
    const source = name.slice(0, -".json".length);
    sourceFiles[source] = loadJson(join(weekDir, name)) as SourceFile;
  }

  return { manifest, sourceFiles, filesOnDisk };
}

/**
 * Returns the JSON content of `path` at git ref `ref`, or null if the path
 * doesn't exist at that ref (a new source, or a new week). See module
 * docstring for why this must catch rather than let execFileSync throw.
 */
function gitShowJson(ref: string, path: string): unknown {
  const relPath = relative(REPO_ROOT, path).split(sep).join("/");
  let stdout: string;
  try {
    stdout = execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null; // non-zero just means "doesn't exist at that ref" -- not an error
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function loadPriorSourceFiles(weekDir: string, ref: string, sources: string[]): Record<string, SourceFile> {
  const prior: Record<string, SourceFile> = {};
  for (const source of sources) {
    const content = gitShowJson(ref, join(weekDir, `${source}.json`));
    if (content !== null) prior[source] = content as SourceFile;
  }
  return prior;
}

export function formatReport(issues: Issue[], week: string): string {
  if (issues.length === 0) {
    return `check_yield: ${week} -- no issues found.`;
  }

  const lines = [`check_yield: ${week} -- ${String(issues.length)} issue(s) found:`];
  const byCheck = new Map<string, Issue[]>();
  for (const issue of issues) {
    const list = byCheck.get(issue.check);
    if (list) list.push(issue);
    else byCheck.set(issue.check, [issue]);
  }

  const labels: Record<string, string> = {
    provenance: "PROVENANCE (fabricated / unfetched)",
    yield_floor: "YIELD FLOOR (suspiciously low)",
    file_agreement: "MANIFEST/FILE MISMATCH",
    non_destructive: "DESTRUCTIVE RE-COLLECTION",
  };
  for (const [check, checkIssues] of byCheck) {
    lines.push(`\n${labels[check] ?? check}:`);
    for (const issue of checkIssues) {
      const prefix = issue.source ? `  [${issue.source}] ` : "  ";
      lines.push(`${prefix}${issue.message}`);
    }
  }

  return lines.join("\n");
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      expected: { type: "string" },
      "check-against-ref": { type: "string" },
    },
  });
  const weekDir = positionals[0];
  if (!weekDir) {
    console.error("usage: check_yield.js <week_dir> [--expected PATH] [--check-against-ref REF]");
    process.exit(2);
  }

  const { manifest, sourceFiles, filesOnDisk } = loadWeekDir(weekDir);
  const expectedPath = values.expected ?? join(DATA_DIR, "expected_yield.json");
  const expected = loadJson(expectedPath) as ExpectedYield;

  let priorSourceFiles: Record<string, SourceFile> | null = null;
  const ref = values["check-against-ref"];
  if (ref) {
    priorSourceFiles = loadPriorSourceFiles(weekDir, ref, Object.keys(manifest.sources ?? {}));
  }

  const issues = collectIssues(manifest, sourceFiles, filesOnDisk, expected, priorSourceFiles);

  console.log(formatReport(issues, manifest.week ?? basename(weekDir)));
  if (issues.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
