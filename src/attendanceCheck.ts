#!/usr/bin/env node
/**
 * Updates the `attended` column of the picks log (data/event-picks-log.csv,
 * or $PICKS_LOG_PATH) for last week's Philadelphia rows, from presence in
 * the "Curated Events" Google Calendar. Per CLAUDE.md's attendance feedback
 * loop: Greg deletes calendar entries he didn't attend, so presence at
 * week's end means attended. Rewrite (not a byte-level port) of
 * scripts/attendance_check.py, checked for the same parsed rows as the
 * Python over every week in the logs csvLog builds from data/.
 *
 * Shelved, like the Python: attendance_check.py is not in runner.sh
 * (CLAUDE.md "Attendance feedback loop"), and this is wired into nothing.
 *
 * The rules are attendance_check.py's docstring, unchanged: "last week" is
 * --week-dir's Monday minus 7 days (never wall-clock today); every matching
 * row is updated regardless of rank, so honorable mentions (which
 * calendar_create never puts on the calendar) always resolve to "false";
 * titles match exactly (case- and whitespace-sensitive).
 *
 * The calendar read is injectable: run() takes a CalendarTitlesFetcher
 * (Monday -> set of event summaries). The default, googleCalendarTitles,
 * uses common.ts's env-var OAuth (getCalendarService/getCalendarId). That
 * path is UNTESTED LIVE: tests and parity runs only ever pass a fake,
 * because the Curated Events calendar is the attendance signal itself.
 *
 * The events.list window (lib/calendar.ts, shared with calendarCreate) is
 * Monday 00:00 to the next Monday 00:00 in America/New_York, each with its
 * own UTC offset (a DST-crossing week gets "-05:00" / "-04:00"), as Python's
 * aware-datetime arithmetic produces. The offset comes from Intl's
 * "longOffset" time-zone name.
 *
 * Divergences from the Python, all intentional:
 *
 * - The log is never truncated before it is validated. The new log is built
 *   in full, written to a temp file in the same directory, and renamed over
 *   the old one. Python opened the log with "w" (emptying it) and then let
 *   DictWriter raise on a bad row, leaving the log cut short.
 * - A log Python would have mangled is rejected up front with a clear
 *   PicksLogError, before the calendar is read, and is left untouched
 *   (lib/picksLog.ts): a header other than PICKS_LOG_COLUMNS (including one
 *   without `attended`, or with unknown or duplicated columns), a row with
 *   more fields than the header, a blank first line (Python: KeyError
 *   'city'), malformed quoting, or an empty file (Python: RuntimeError).
 * - Encoding: always UTF-8; Python used the locale's (UTF-8 on every machine
 *   this has run on). A leading BOM is dropped.
 * - --dry-run never writes the log. Like the Python, it still reads the
 *   calendar (read-only), so its counts are real.
 * - The --week-dir name must be YYYY-MM-DD. Python's date.fromisoformat
 *   also accepts "20260622" and "2026-W26-1".
 * - The events.list offset comes from Node's ICU time-zone data rather than
 *   the system tzdata. They agree for America/New_York on every date this
 *   pipeline can see. Pre-1883 dates (local mean time) are not supported.
 * - Errors: a Calendar API failure is googleapis' GaxiosError rather than
 *   googleapiclient's HttpError; errors exit 1 with a JS stack instead of a
 *   traceback; bad arguments print a usage line and exit 2, and argparse's
 *   prefix matching (`--week`, `--dry`) is not supported.
 * - The printed log path is picksLogPath()'s, which resolves `..` in a
 *   relative PICKS_LOG_PATH. Same file; only the message text differs.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getCalendarId, getCalendarService, picksLogPath } from "./common.js";
import { type CalendarListService, addDays, listWeekEvents } from "./lib/calendar.js";
import { type PicksLogRow, formatPicksLog, parsePicksLog, readLogText, writeFileAtomic } from "./lib/picksLog.js";

// ---------------------------------------------------------------------------
// Week math
// ---------------------------------------------------------------------------

export function lastWeekMonday(targetMonday: string): string {
  return addDays(targetMonday, -7);
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** Last week's Monday (YYYY-MM-DD) -> the summaries of every event in that week. */
export type CalendarTitlesFetcher = (monday: string) => Promise<Set<string>>;

export async function fetchCalendarTitles(
  service: CalendarListService,
  calendarId: string,
  monday: string,
): Promise<Set<string>> {
  const titles = new Set<string>();
  for (const { summary } of await listWeekEvents(service, calendarId, monday)) {
    if (summary) titles.add(summary);
  }
  return titles;
}

/**
 * The real fetcher: Google Calendar via env-var OAuth (common.ts). UNTESTED
 * LIVE -- nothing in this repo's tests or parity runs calls it.
 */
export async function googleCalendarTitles(monday: string): Promise<Set<string>> {
  const service = getCalendarService();
  const calendarId = await getCalendarId(service);
  return fetchCalendarTitles(service, calendarId, monday);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type AttendanceFields = Pick<PicksLogRow, "city" | "week_of" | "title" | "attended">;

function isTargetRow(row: AttendanceFields, weekOf: string): boolean {
  return row.city === "Philadelphia" && row.week_of === weekOf;
}

/** Sets `attended` on every Philadelphia row for `weekOf`, in place; returns how many rows that was. */
export function updateAttendance(rows: AttendanceFields[], weekOf: string, calendarTitles: ReadonlySet<string>): number {
  const targets = rows.filter((row) => isTargetRow(row, weekOf));
  for (const row of targets) row.attended = calendarTitles.has(row.title) ? "true" : "false";
  return targets.length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface RunOptions {
  weekDir: string;
  dryRun: boolean;
}

export async function run(
  { weekDir, dryRun }: RunOptions,
  fetchTitles: CalendarTitlesFetcher = googleCalendarTitles,
): Promise<void> {
  // basename ignores a trailing slash, as pathlib's .name does.
  const weekOf = lastWeekMonday(basename(weekDir));

  const logPath = picksLogPath();
  const text = readLogText(logPath);
  if (text === null) {
    console.log(`No picks log at ${logPath}; nothing to check.`);
    return;
  }
  const rows = parsePicksLog(text, logPath);

  if (!rows.some((row) => isTargetRow(row, weekOf))) {
    console.log(`No Philadelphia rows for week_of=${weekOf}; skipping.`);
    return;
  }

  const updated = updateAttendance(rows, weekOf, await fetchTitles(weekOf));
  const attended = rows.filter((row) => isTargetRow(row, weekOf) && row.attended === "true").length;
  const counts = `(${String(attended)} attended, ${String(updated - attended)} not attended).`;

  if (dryRun) {
    console.log(`[dry-run] Would update ${String(updated)} rows for week_of=${weekOf} ${counts}`);
    return;
  }

  writeFileAtomic(logPath, formatPicksLog(rows));
  console.log(`Attendance check complete. ${String(updated)} rows updated for week_of=${weekOf} ${counts}`);
}

const USAGE = "usage: attendanceCheck.js [-h] --week-dir WEEK_DIR [--dry-run]";

async function main(): Promise<void> {
  let values: { "week-dir"?: string | undefined; "dry-run"?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { "week-dir": { type: "string" }, "dry-run": { type: "boolean", default: false } },
    }));
  } catch (err) {
    console.error(`${USAGE}\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const weekDir = values["week-dir"];
  if (weekDir === undefined) {
    console.error(`${USAGE}\nthe following arguments are required: --week-dir`);
    process.exit(2);
  }
  await run({ weekDir, dryRun: values["dry-run"] ?? false });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
