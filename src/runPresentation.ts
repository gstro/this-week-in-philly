#!/usr/bin/env node
/**
 * Presentation's script step: the TS replacement for scripts/runner.sh.
 * Runs, in order, spotifyLookup -> spotifyPlaylist -> htmlRender ->
 * calendarCreate for one week, each as its own CLI process (exactly what
 * runner.sh did), so each keeps its own exit code and `--dry-run` handling.
 *
 *   node dist/runPresentation.js data/YYYY-MM-DD [--dry-run]
 *
 * (merge_selections and check_selection are separate workflow steps before
 * this one, as with the Python.)
 *
 * A Spotify failure never stops the report (decided 2026-10-14). If the
 * lookup fails or times out, a ::warning:: is printed, the playlist step is
 * skipped (it would build from a stale or missing `_spotify.json`), and the
 * run goes on to render the report, which renders without Spotify links when
 * `_spotify.json`/`_playlist.json` are absent. A failing playlist step is
 * the same: a warning, not a stop. (spotifyPlaylist already exits 0 on its
 * own failures; this also covers a crash or a bad exit.) The lookup is cut
 * off after 10 minutes, so a hung Spotify call cannot hold the job open.
 *
 * Everything else is fatal and stops the run with that step's exit code:
 * htmlRender (no report) and calendarCreate (whose past-week guard exits 0
 * on a refused week, so a guarded re-render still succeeds).
 *
 * Divergence from runner.sh: none in order or flags; the Python's `set -e`
 * aborted on a Spotify failure (the runner.sh in the repo now carries the
 * same decision, for the period both engines exist).
 */

import { spawn } from "node:child_process";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOOKUP_TIMEOUT_MS = 10 * 60_000;

/** Runs a sibling CLI (e.g. "htmlRender.js"; an absolute path is used as is) with `args`; resolves its exit code (nonzero for a signal or timeout). */
export type RunStep = (script: string, args: string[], options?: { timeoutMs?: number }) => Promise<number>;

const HERE = dirname(fileURLToPath(import.meta.url));

export const spawnStep: RunStep = (script, args, { timeoutMs } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [resolvePath(HERE, script), ...args], {
      stdio: "inherit",
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    });
    child.on("error", (err) => {
      console.error(`${script}: could not start: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) console.error(`${script}: ended by ${signal}${timeoutMs !== undefined ? ` (timeout ${String(timeoutMs / 1000)}s)` : ""}`);
      resolve(code ?? 1);
    });
  });

export interface PresentationOptions {
  weekDir: string;
  dryRun: boolean;
  run?: RunStep;
}

const warn = (message: string): void => {
  console.log(`::warning::${message}`);
};

/** Returns the exit code for the whole step. */
export async function runPresentation({ weekDir, dryRun, run = spawnStep }: PresentationOptions): Promise<number> {
  const dryFlag = dryRun ? ["--dry-run"] : [];
  const htmlPath = join("docs", "weeks", `${basename(weekDir)}.html`);

  // Spotify: never fatal.
  let lookup = await run("spotifyLookup.js", [weekDir], { timeoutMs: LOOKUP_TIMEOUT_MS }).catch(() => 1);
  if (lookup !== 0) {
    warn(`spotifyLookup failed (exit ${String(lookup)}); the report renders without Spotify links and no playlist is built.`);
  } else {
    lookup = await run("spotifyPlaylist.js", [weekDir, ...dryFlag]).catch(() => 1);
    if (lookup !== 0) warn(`spotifyPlaylist failed (exit ${String(lookup)}); the report renders without a playlist link.`);
  }

  const rendered = await run("htmlRender.js", [weekDir, htmlPath]);
  if (rendered !== 0) return rendered;

  return run("calendarCreate.js", [weekDir, ...dryFlag]);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((arg) => arg !== "--dry-run");
  const [weekDir] = args;
  if (!weekDir || args.length > 1 || argv.length - args.length > 1) {
    console.error("usage: runPresentation.js week_dir [--dry-run]");
    return 2;
  }
  return runPresentation({ weekDir, dryRun: argv.includes("--dry-run") });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
