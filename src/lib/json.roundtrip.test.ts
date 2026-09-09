import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJson, writeJsonAsciiEscaped } from "./json.js";

/**
 * Fidelity trap #4 from the migration plan: before porting any Tier A
 * business logic, prove the two JSON writers reproduce Python's
 * `json.dumps(value, indent=2, ...)` formatting -- 2-space indent, matching
 * key order, and (per artifact type) the right ASCII-escaping convention --
 * across every real JSON artifact this pipeline has ever committed. A single
 * formatting divergence here would silently fail every later parity check
 * against real week data.
 *
 * `data/expected_yield.json` is excluded: it's hand-maintained config data
 * (edited in a text editor, which appends its own trailing newline), not a
 * script-written pipeline artifact, so it isn't part of any writer's
 * round-trip contract.
 *
 * `_selection_annotations.json` is also excluded: it's written directly by
 * the Selection Routine (an LLM), not by `json.dumps`, and some of its
 * objects come out compact/single-line rather than pretty-printed (e.g.
 * `{ "id": "c0030" }`). `merge_selections.py` only ever reads this file, so
 * there is no writer whose formatting this port needs to reproduce.
 *
 * Each script's own trailing-newline convention (most write none via
 * `Path.write_text`; `spotify_playlist.py` deliberately appends one via
 * `f.write("\n")`) is that script's contract to replicate when it's ported,
 * not this serializer's -- so exactly one trailing "\n" is tolerated here on
 * either side of the comparison.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function findJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...findJsonFiles(full));
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function stripOneTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * Which convention applies to a given committed artifact. Determined by
 * path/filename, per the module doc above -- everything from
 * `prepare_selection_input.py` onward (including Selection's own
 * `_selection_annotations.json`) is literal UTF-8; raw Collection output
 * (bare per-source files, `_manifest.json`) is ASCII-escaped.
 */
function writerFor(path: string): (value: unknown) => string {
  const base = basename(path);
  if (path.includes("/_candidates/")) return writeJson;
  if (base === "_manifest.json") return writeJsonAsciiEscaped;
  const literalUtf8Names = new Set([
    "_candidates.json",
    "_selections.json",
    "_recent_picks.json",
    "_spotify.json",
    "_playlist.json",
  ]);
  if (literalUtf8Names.has(base)) return writeJson;
  // Any other top-level, non-underscore-prefixed file is a raw per-source
  // Collection artifact (e.g. do215.json, wxpn.json, luma.json).
  return writeJsonAsciiEscaped;
}

const candidateDirs = ["data", "archive"];
const jsonFiles = candidateDirs
  .map((dir) => join(REPO_ROOT, dir))
  .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
  .flatMap((dir) => findJsonFiles(dir))
  .filter((path) => path !== join(REPO_ROOT, "data", "expected_yield.json"))
  .filter((path) => basename(path) !== "_selection_annotations.json");

describe("JSON writers round-trip every committed JSON artifact", () => {
  it.each(jsonFiles.map((path) => [path.replace(`${REPO_ROOT}/`, ""), path] as const))(
    "%s",
    (_label, path) => {
      const original = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(original);
      const rewritten = writerFor(path)(parsed);
      expect(stripOneTrailingNewline(rewritten)).toBe(stripOneTrailingNewline(original));
    },
  );

  it("found a non-trivial number of fixtures to check", () => {
    expect(jsonFiles.length).toBeGreaterThan(100);
  });

  it("exercised both the ASCII-escaped and literal-UTF-8 conventions", () => {
    const withEscapes = jsonFiles.filter((f) => /\\u[0-9a-f]{4}/i.test(readFileSync(f, "utf8")));
    // eslint-disable-next-line no-control-regex -- deliberately matches any byte outside ASCII, control chars included
    const withRawNonAscii = jsonFiles.filter((f) => /[^\x00-\x7f]/.test(readFileSync(f, "utf8")));
    expect(withEscapes.length).toBeGreaterThan(0);
    expect(withRawNonAscii.length).toBeGreaterThan(0);
  });
});
