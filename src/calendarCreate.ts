#!/usr/bin/env node
/**
 * Writes a week's Top 3 picks to the "Curated Events" Google Calendar: clears
 * the *target* (upcoming) week's existing entries, then inserts up to 21
 * events (3 per day, fewer where a day has fewer qualifying picks). Rewrite
 * (not a byte-level port) of scripts/calendar_create.py.
 *
 * This is the pipeline's one hard-to-undo mutation, so the rules in the
 * Python's docstring are kept as they are:
 *
 * - The past-week guard (`weekHasAlreadyBegun`): a week whose Monday is
 *   before today (Eastern) is refused, exit 0, so the report still renders.
 *   It runs after the selections load and before events are built, before
 *   `--dry-run` and before any auth, so `calendarCreate data/<past-week>` --
 *   the exact command behind the 2026-08-23 incident, which wiped and
 *   recreated all 21 entries of an already-ended week and destroyed its
 *   attendance signal -- cannot reach the network. `--force-calendar`
 *   overrides. The comparison is `<`, not `!==`: a Sunday-evening-Eastern run
 *   has already crossed into Monday UTC, and an equality test would refuse
 *   the on-schedule run. Do not tighten it.
 * - End times from v1: literary +90 min, film +2 h, concert +3 h, festival
 *   +6 h. The other five categories have no documented heuristic and take
 *   +2 h, an inference never validated against real calendar data.
 * - `location` is the pick's `address` if present, else omitted (not a venue
 *   name fallback). The `Cost:` line appears only for a confirmed cost.
 *
 * Event times are Eastern wall-clock times, written as RFC 3339 with that
 * moment's own offset ("2026-06-22T18:00:00-04:00"). The end time is a
 * wall-clock add (6 PM + 3 h = 9 PM, rolling into the next day if need be),
 * as Python's aware-datetime `+ timedelta` does, so across a DST change the
 * elapsed time differs by an hour. A wall time inside the spring-forward gap
 * (a Saturday 11 PM concert ending "2:00 AM" on 03-08) takes the offset from
 * before the change, again as Python's zoneinfo does (lib/calendar.ts).
 *
 * Live calendar writes are never exercised by tests or parity runs: the
 * service is injectable and the tests use a recording fake. The first real
 * write is the Tier D cutover.
 *
 * Divergences from the Python, all intentional:
 *
 * - The Python deletes each page's events while still following the page
 *   token, which can skip events once a week spans more than one page. Every
 *   id is listed across all pages first, then deleted.
 * - The clear leaves alone an event that started before the week (listing
 *   returns every event overlapping the window, so a Sunday-night festival
 *   running past midnight into Monday would be deleted, and with it last
 *   week's attendance signal). The Python deleted it.
 * - A malformed first date (not YYYY-MM-DD) is an error; the guard's string
 *   comparison would otherwise misorder "2026-8-17".
 * - A delete answered 404/410 (already gone, or a retried delete whose first
 *   attempt landed) counts as deleted. The Python crashed mid-clear.
 * - googleapis retries list and delete on 5xx/429 (gaxios defaults); it never
 *   retries `events.insert` (POST), so a timeout cannot create a duplicate
 *   entry. The Python (googleapiclient) retried nothing.
 * - A time must be `H:MM AM/PM` (separator required, minutes two digits, hour
 *   1-12, any case). Python's strptime also accepted a one-digit minute.
 * - Errors print one line and exit 1, not a traceback; bad arguments print a
 *   usage line and exit 2.
 * - Kept on purpose: clear-then-insert is not atomic. An insert failure
 *   leaves a partial week; a re-run clears and rewrites it.
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CATEGORY_ORDER, getCalendarId, getCalendarService, isPlaceholderCost, loadSelections, stripPlaceholderWrapper } from "./common.js";
import { parseIsoDate } from "./htmlRender.js";
import {
  type CalendarEventsService,
  type EventBody,
  addDays,
  calendarWeekWindow,
  easternIso,
  listWeekEvents,
  todayEastern,
} from "./lib/calendar.js";
import { errorMessage } from "./lib/http.js";

const LITERARY = CATEGORY_ORDER[2];
const FILM = CATEGORY_ORDER[1];
const MUSIC = CATEGORY_ORDER[0];
const FESTIVAL = CATEGORY_ORDER[8];

export const END_TIME_DELTA_MINUTES: Readonly<Record<string, number>> = {
  [LITERARY]: 90,
  [FILM]: 120,
  [MUSIC]: 180,
  [FESTIVAL]: 360,
};
export const DEFAULT_END_TIME_DELTA_MINUTES = 120;

export interface TopPick {
  title: string;
  time?: string;
  category: string;
  why: string;
  cost?: string;
  url?: string;
  address?: string;
}

export interface Day {
  date: string;
  top3: TopPick[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Minutes after midnight for "6:00 PM" (any case, one or more spaces), or null if it is not a time. */
export function parseTime(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s+([AP]M)$/i.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return ((hour % 12) + (match[3]?.toUpperCase() === "PM" ? 12 : 0)) * 60 + minute;
}

/** `date` plus `minutes` after midnight (which may pass 24h) as an Eastern RFC 3339 timestamp. */
function wallClockIso(date: string, minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  return easternIso(addDays(date, days), Math.floor(rest / 60), rest % 60);
}

/** The start as minutes after midnight, or null when the date or time is unusable (empty, a placeholder, malformed). */
export function parseStart(dayDate: string, eventTime: string): number | null {
  if (!parseIsoDate(dayDate)) return null;
  return parseTime(stripPlaceholderWrapper(eventTime));
}

export function buildEvent(day: { date: string }, pick: TopPick): EventBody | null {
  const start = parseStart(day.date, pick.time ?? "");
  if (start === null) {
    console.error(`  Skipping '${pick.title}' (${day.date}): unparseable/missing time`);
    return null;
  }
  const minutes = END_TIME_DELTA_MINUTES[pick.category] ?? DEFAULT_END_TIME_DELTA_MINUTES;

  const description = [pick.why];
  if (pick.cost && !isPlaceholderCost(pick.cost)) description.push(`Cost: ${pick.cost}`);
  if (pick.url) description.push(pick.url);

  const event: EventBody = {
    summary: pick.title,
    start: { dateTime: wallClockIso(day.date, start) },
    end: { dateTime: wallClockIso(day.date, start + minutes) },
    description: description.join("\n\n"),
  };
  if (pick.address) event.location = pick.address;
  return event;
}

// ---------------------------------------------------------------------------
// The past-week guard
// ---------------------------------------------------------------------------

/**
 * True when `monday` is in the past, i.e. the week is over or underway.
 * "Today" is Eastern, not the runner's UTC date (see lib/calendar.ts).
 * Deliberately `<` and not `!==` -- see the module header.
 */
export function weekHasAlreadyBegun(monday: string, today: string = todayEastern()): boolean {
  return monday < today;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Calendar writes
// ---------------------------------------------------------------------------

function httpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const fields = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = Number(fields.status ?? fields.response?.status ?? fields.code);
  return Number.isInteger(status) ? status : undefined;
}

/** Deletes every event in the week starting `monday`; returns how many. */
export async function clearTargetWeek(service: CalendarEventsService, calendarId: string, monday: string): Promise<number> {
  // Every id first: deleting while following the page token can skip events.
  const weekStart = Date.parse(calendarWeekWindow(monday).timeMin);
  const ids = (await listWeekEvents(service, calendarId, monday)).flatMap(({ id, start }) => {
    const startedBefore = start?.dateTime ? Date.parse(start.dateTime) < weekStart : false;
    return id && !startedBefore ? [id] : [];
  });
  for (const eventId of ids) {
    try {
      await service.events.delete({ calendarId, eventId });
    } catch (err) {
      const status = httpStatus(err);
      if (status !== 404 && status !== 410) throw err; // already gone is fine
    }
  }
  return ids.length;
}

export interface Deps {
  today?: () => string;
  getService?: () => Promise<{ service: CalendarEventsService; calendarId: string }>;
}

async function googleService(): Promise<{ service: CalendarEventsService; calendarId: string }> {
  const service = getCalendarService();
  return { service, calendarId: await getCalendarId(service) };
}

const USAGE = "usage: calendarCreate.js [--dry-run] [--force-calendar] week_dir";

/** The CLI; returns the exit code (0 also when the guard refuses a past week; 1 on failure; 2 for bad arguments). */
export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "dry-run": { type: "boolean", default: false }, "force-calendar": { type: "boolean", default: false } },
    });
  } catch (err) {
    console.error(`${USAGE}\n${errorMessage(err)}`);
    return 2;
  }
  const [weekDir] = parsed.positionals;
  if (!weekDir || parsed.positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }

  try {
    const { days } = loadSelections(weekDir) as { days: Day[] };
    const monday = days[0]?.date;
    if (!monday) throw new Error(`${weekDir}/_selections.json has no days`);
    if (!parseIsoDate(monday)) throw new Error(`${weekDir}/_selections.json: first day is not YYYY-MM-DD: ${JSON.stringify(monday)}`);

    // Before auth, before the service object, before --dry-run: a past-week
    // run must not be able to reach the network at all.
    const today = (deps.today ?? todayEastern)();
    if (!parsed.values["force-calendar"] && weekHasAlreadyBegun(monday, today)) {
      console.log(
        `calendar_create: REFUSING to write.\n` +
          `  Week ${monday} began ${String(daysBetween(monday, today))} day(s) ago.\n` +
          `  Clearing a week that has already started destroys the attendance signal --\n` +
          `  presence of an entry at week's end is what records that Greg attended it\n` +
          `  (see CLAUDE.md's 'Attendance feedback loop').\n` +
          `  Skipping the calendar write; the rest of the pipeline still runs.\n` +
          `  Pass --force-calendar to override.`,
      );
      return 0;
    }

    const events = days.flatMap((day) => day.top3.flatMap((pick) => buildEvent(day, pick) ?? []));

    if (parsed.values["dry-run"]) {
      console.log(`[dry-run] Would clear existing events for week of ${monday} and create ${String(events.length)} new events.`);
      return 0;
    }

    const { service, calendarId } = await (deps.getService ?? googleService)();
    const deleted = await clearTargetWeek(service, calendarId, monday);
    let created = 0;
    for (const requestBody of events) {
      await service.events.insert({ calendarId, requestBody });
      created += 1;
    }
    console.log(`Calendar sync complete. Cleared ${String(deleted)} stale events, created ${String(created)} events for week of ${monday}.`);
    return 0;
  } catch (err) {
    console.error(`calendar_create: ${errorMessage(err)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
