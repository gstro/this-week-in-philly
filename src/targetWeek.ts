#!/usr/bin/env node
/**
 * Prints the Monday of the week the pipeline should cover (common.targetWeekMonday:
 * the Monday immediately following the run date), as YYYY-MM-DD. The CLI the
 * workflows use in place of `python3 -c "import common; ..."`.
 *
 *   node dist/targetWeek.js [YYYY-MM-DD]     # optional date to pretend it is today
 */

import { pathToFileURL } from "node:url";
import { targetWeekMonday } from "./common.js";

/** Returns the exit code; writes the Monday to `out`. */
export function run(argv: string[], out: (line: string) => void = console.log): number {
  const [today, ...extra] = argv;
  if (extra.length > 0 || (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today))) {
    console.error("usage: targetWeek.js [YYYY-MM-DD]");
    return 2;
  }
  out(targetWeekMonday(today));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = run(process.argv.slice(2));
}
