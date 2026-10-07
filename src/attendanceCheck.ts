#!/usr/bin/env node
/**
 * Port of scripts/attendance_check.py -- updates the `attended` column in
 * data/event-picks-log.csv (or $PICKS_LOG_PATH) for last week's Philadelphia
 * rows, based on presence in the "Curated Events" Google Calendar. Per
 * CLAUDE.md's attendance feedback loop: Greg deletes calendar entries he
 * didn't attend, so presence at week's end means attended.
 *
 * Shelved, like the Python: attendance_check.py is not in runner.sh
 * (CLAUDE.md "Attendance feedback loop"), and this port is wired into
 * nothing.
 *
 * See attendance_check.py's module docstring for the rules this inherits
 * unchanged: "last week" is --week-dir's Monday minus 7 days (never
 * wall-clock today); every matching row is updated regardless of rank, so
 * honorable mentions (which calendar_create never puts on the calendar)
 * always resolve to "false"; titles match exactly (case- and
 * whitespace-sensitive).
 *
 * The calendar read is injectable. run() takes a CalendarTitlesFetcher
 * (monday -> set of event summaries); the default, googleCalendarTitles,
 * goes through common.ts's getCalendarService()/getCalendarId(), i.e. the
 * same GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN env-var
 * auth as common.py's get_calendar_credentials(). It uses the `googleapis`
 * package common.ts already depends on, so this port adds no dependency.
 * That real-call path is UNTESTED LIVE: the tests and the parity harness
 * only ever drive fetchCalendarTitles() with a fake `events.list`, because
 * the Curated Events calendar is the attendance signal itself and no test
 * may touch it. Note that --dry-run, like the Python's, still performs the
 * (read-only) calendar fetch; it only skips writing the CSV.
 *
 * CSV I/O reuses csvLog.ts's CPython-transcribed reader (readCsvDict, which
 * reproduces csv.DictReader including None-vs-[] fieldnames) and writer
 * (formatCsvRow); writeDictRows() adds csv.DictWriter's extrasaction="raise"
 * check and restval="" fill on top.
 *
 * Week math. lastWeekMonday() is plain calendar-date arithmetic in UTC
 * (no DST can shift a date). The events.list window is
 * `datetime.combine(monday, time.min, tzinfo=ZoneInfo("America/New_York"))`
 * and that plus `timedelta(days=7)`: Python's aware-datetime + timedelta is
 * wall-clock arithmetic, so timeMax is the *next* Monday's local midnight
 * with its own UTC offset -- a DST-crossing week gets e.g.
 * "2026-03-02T00:00:00-05:00" / "2026-03-09T00:00:00-04:00", not a fixed
 * 168 hours. easternMidnightIso() reproduces that: it resolves the offset
 * with Intl for the wall time using zoneinfo's fold=0 rule (the
 * pre-transition offset for an ambiguous or skipped wall time; midnight is
 * never either in America/New_York, but the rule is mirrored anyway) and
 * formats it like isoformat(), with a :SS suffix only for a non-whole-minute
 * offset (pre-1883 LMT).
 *
 * Divergences from the Python, all intentional:
 *
 * - tz database. Python's zoneinfo reads the system tzdata (or the tzdata
 *   wheel); Node uses ICU's bundled copy. They agree for America/New_York
 *   on every date this pipeline can see; a future rule change could land in
 *   one before the other.
 * - Date parsing. The --week-dir name is parsed with htmlRender.ts's strict
 *   YYYY-MM-DD parseIsoDate, where Python 3.12's `date.fromisoformat` also
 *   takes "20260622" and "2026-W26-1"; both reject everything else (a
 *   ValueError there, a thrown Error here, exit 1 either way). Every week
 *   dir is YYYY-MM-DD.
 * - Errors. A Calendar API failure surfaces as googleapis' GaxiosError
 *   rather than googleapiclient's HttpError; missing env vars, a missing
 *   "Curated Events" calendar, KeyError-equivalents (a log with no `city`
 *   or `week_of` column) and the RuntimeError for a header-less log all
 *   exit 1 with a JS stack instead of a traceback. argparse's usage/exit-2
 *   is approximated by a one-line usage message and exit 2, and argparse's
 *   unambiguous-prefix matching (`--week`, `--dry`) is not supported.
 * - DictWriter's ValueError lists every unexpected key; Python joins them in
 *   set-iteration order (hash-seed dependent when both None and 'attended'
 *   are present), this joins them in row-key order.
 * - Encoding and the printed log path, inherited from csvLog.ts: always
 *   UTF-8 (Python: the locale encoding, UTF-8 on every machine this runs
 *   on), and picksLogPath() resolves `..` in a relative PICKS_LOG_PATH where
 *   Python prints it unresolved -- same file, different message text.
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CALENDAR_TIMEZONE, getCalendarId, getCalendarService, picksLogPath } from "./common.js";
import { type CsvDictRow, formatCsvRow, readCsvDict, readUtf8 } from "./csvLog.js";
import { parseIsoDate } from "./htmlRender.js";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Week math
// ---------------------------------------------------------------------------

/** A Date at UTC midnight of a YYYY-MM-DD string (throws like date.fromisoformat on anything else). */
function utcDate(iso: string): Date {
  const d = parseIsoDate(iso);
  if (!d) throw new Error(`ValueError: Invalid isoformat string: '${iso}'`);
  const date = new Date(0);
  date.setUTCFullYear(d.year, d.month - 1, d.day); // not Date.UTC: it maps years 0-99 to 19xx
  return date;
}

function isoFromUtc(date: Date): string {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) throw new Error("OverflowError: date value out of range");
  const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
  return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `date.fromisoformat(s) + timedelta(days=n)`, as YYYY-MM-DD. */
function addDays(iso: string, days: number): string {
  return isoFromUtc(new Date(utcDate(iso).getTime() + days * DAY_MS));
}

export function lastWeekMonday(targetMonday: string): string {
  return addDays(targetMonday, -7);
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset (ms, east-positive) of `timeZone` at the UTC instant `instantMs`. */
function offsetAt(timeZone: string, instantMs: number): number {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneFormatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(new Date(instantMs))) parts[type] = value;
  let year = Number(parts["year"]);
  if (parts["era"] === "BC" || parts["era"] === "B") year = 1 - year;
  const wall = new Date(0);
  wall.setUTCFullYear(year, Number(parts["month"]) - 1, Number(parts["day"]));
  wall.setUTCHours(Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"]));
  return wall.getTime() - Math.floor(instantMs / 1000) * 1000;
}

/**
 * `datetime.combine(date, time.min, tzinfo=ZoneInfo(timeZone)).isoformat()`,
 * e.g. "2026-06-15T00:00:00-04:00". Offset chosen per zoneinfo's fold=0.
 */
export function easternMidnightIso(isoDate: string, timeZone: string = CALENDAR_TIMEZONE): string {
  const wallMs = utcDate(isoDate).getTime();
  // The offsets in effect half a day either side of the wall time: equal
  // unless a transition is nearby (America/New_York's are months apart).
  const before = offsetAt(timeZone, wallMs - DAY_MS / 2);
  const after = offsetAt(timeZone, wallMs + DAY_MS / 2);
  const valid = (o: number): boolean => offsetAt(timeZone, wallMs - o) === o;
  // fold=0: the pre-transition offset, unless only the post-transition one
  // actually produces this wall time.
  const offsetMs = !valid(before) && valid(after) ? after : before;

  const sign = offsetMs < 0 ? "-" : "+";
  const total = Math.abs(offsetMs) / 1000;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const hh = pad(Math.floor(total / 3600));
  const mm = pad(Math.floor((total % 3600) / 60));
  const ss = total % 60;
  return `${isoDate}T00:00:00${sign}${hh}:${mm}${ss ? `:${pad(ss)}` : ""}`;
}

/** The events.list window: Monday 00:00 Eastern through the next Monday 00:00 Eastern (wall clock). */
export function calendarWeekWindow(monday: string): { timeMin: string; timeMax: string } {
  return { timeMin: easternMidnightIso(monday), timeMax: easternMidnightIso(addDays(monday, 7)) };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface EventsListParams {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  singleEvents: boolean;
  pageToken?: string;
}

export interface EventsPage {
  items?: { summary?: string | null }[] | null;
  nextPageToken?: string | null;
}

/** The slice of googleapis' calendar_v3.Calendar this module uses; tests pass a fake. */
export interface CalendarEventsService {
  events: { list(params: EventsListParams): Promise<{ data: EventsPage }> };
}

/** Last week's Monday (YYYY-MM-DD) -> the summaries of every event in that week. */
export type CalendarTitlesFetcher = (monday: string) => Promise<Set<string>>;

export async function fetchCalendarTitles(
  service: CalendarEventsService,
  calendarId: string,
  monday: string,
): Promise<Set<string>> {
  const { timeMin, timeMax } = calendarWeekWindow(monday);
  const titles = new Set<string>();
  let pageToken: string | undefined;
  for (;;) {
    // googleapiclient drops a None pageToken from the request; so does this.
    const params: EventsListParams = { calendarId, timeMin, timeMax, singleEvents: true };
    if (pageToken) params.pageToken = pageToken;
    const { data } = await service.events.list(params);
    for (const event of data.items ?? []) {
      const summary = event.summary;
      if (summary) titles.add(summary);
    }
    pageToken = data.nextPageToken ?? undefined;
    if (!pageToken) break;
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

/** `row[key]`: a KeyError-equivalent when the column is absent. */
function col(row: CsvDictRow, key: string): string | string[] | null {
  if (!row.has(key)) throw new Error(`KeyError: '${key}'`);
  return row.get(key) ?? null;
}

/** `row["city"] == "Philadelphia" and row["week_of"] == week_of`, short-circuit included. */
function isTargetRow(row: CsvDictRow, weekOf: string): boolean {
  return col(row, "city") === "Philadelphia" && col(row, "week_of") === weekOf;
}

export function updateAttendance(rows: readonly CsvDictRow[], weekOf: string, calendarTitles: ReadonlySet<string>): number {
  let updated = 0;
  for (const row of rows) {
    if (isTargetRow(row, weekOf)) {
      const title = col(row, "title");
      row.set("attended", typeof title === "string" && calendarTitles.has(title) ? "true" : "false");
      updated += 1;
    }
  }
  return updated;
}

/** Python's repr() of a DictReader key. */
function reprKey(key: string | null): string {
  if (key === null) return "None";
  return key.includes("'") && !key.includes('"') ? `"${key}"` : `'${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * `open(path, "w", newline="")` + csv.DictWriter(fieldnames).writeheader() +
 * writerows(rows). The file is truncated up front and rows are written in
 * order, so a row with a key outside `fieldnames` (DictWriter's ValueError)
 * leaves the header plus every earlier row on disk and throws -- the
 * Python's behaviour, reproduced rather than fixed. In practice the only
 * keys that can trip it are None (a data row longer than the header) and
 * "attended" (a log whose header lacks that column, which updateAttendance
 * then adds) -- either way the original log is truncated to a prefix.
 */
export function writeDictRows(path: string, fieldnames: readonly string[], rows: readonly CsvDictRow[]): void {
  let out = formatCsvRow(fieldnames);
  const allowed = new Set<string | null>(fieldnames);
  try {
    for (const row of rows) {
      const wrong = [...row.keys()].filter((k) => !allowed.has(k));
      if (wrong.length > 0) {
        throw new Error(`ValueError: dict contains fields not in fieldnames: ${wrong.map(reprKey).join(", ")}`);
      }
      out += formatCsvRow(
        fieldnames.map((name) => {
          const value = row.has(name) ? (row.get(name) ?? null) : "";
          // Only the None-keyed extras can hold a list, and those raised above.
          return Array.isArray(value) ? JSON.stringify(value) : value;
        }),
      );
    }
  } finally {
    writeFileSync(path, out, "utf8");
  }
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
  // Path(...).name: basename ignores a trailing slash, as pathlib does.
  const targetMonday = basename(weekDir);
  const weekOf = lastWeekMonday(targetMonday);

  const logPath = picksLogPath();
  if (!existsSync(logPath)) {
    console.log(`No picks log at ${logPath}; nothing to check.`);
    return;
  }

  const { fieldnames, rows } = readCsvDict(readUtf8(logPath));
  if (fieldnames === null) {
    throw new Error(`RuntimeError: ${logPath} has no header row`);
  }

  const matching = rows.filter((r) => isTargetRow(r, weekOf));
  if (matching.length === 0) {
    console.log(`No Philadelphia rows for week_of=${weekOf}; skipping.`);
    return;
  }

  const calendarTitles = await fetchTitles(lastWeekMonday(targetMonday));

  const updated = updateAttendance(rows, weekOf, calendarTitles);
  const attendedTrue = rows.filter((r) => isTargetRow(r, weekOf) && col(r, "attended") === "true").length;
  const counts = `(${String(attendedTrue)} attended, ${String(updated - attendedTrue)} not attended).`;

  if (dryRun) {
    console.log(`[dry-run] Would update ${String(updated)} rows for week_of=${weekOf} ${counts}`);
    return;
  }

  writeDictRows(logPath, fieldnames, rows);
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
