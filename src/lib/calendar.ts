/**
 * Google Calendar helpers shared by attendanceCheck (read) and calendarCreate
 * (clear + write): the Eastern week window, Eastern timestamps, "today in
 * Eastern", and the paged week listing.
 *
 * The service types below are the slices of googleapis' calendar_v3.Calendar
 * these modules use, so tests pass a recording fake instead.
 */
import { CALENDAR_TIMEZONE } from "../common.js";
import { parseIsoDate } from "../htmlRender.js";

const DAY_MS = 86_400_000;

export function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate);
  if (!date) throw new Error(`not a YYYY-MM-DD date: ${JSON.stringify(isoDate)}`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: CALENDAR_TIMEZONE, timeZoneName: "longOffset" });

/** America/New_York's UTC offset at an instant, in ms (east-positive). */
function easternOffsetMs(instantMs: number): number {
  const name = offsetFormat.formatToParts(instantMs).find((part) => part.type === "timeZoneName")?.value ?? "";
  if (name === "GMT") return 0;
  // Whole-minute offsets only; LMT's "GMT-04:56:02" (pre-1883) is rejected.
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) throw new Error(`unsupported ${CALENDAR_TIMEZONE} offset: ${JSON.stringify(name)}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "-" ? -1 : 1) * minutes * 60_000;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The UTC offset (ms, east-positive) in force at an Eastern wall-clock time
 * given as if it were UTC. Resolves the two ambiguous cases the way Python's
 * zoneinfo does for an aware datetime with fold=0: a repeated wall time
 * (fall-back hour) takes its first occurrence, and a skipped wall time (the
 * spring-forward gap) takes the offset from before the transition.
 */
function wallOffsetMs(wallMs: number): number {
  const before = easternOffsetMs(wallMs - DAY_MS);
  const after = easternOffsetMs(wallMs + DAY_MS);
  for (const candidate of [before, after]) {
    if (easternOffsetMs(wallMs - candidate) === candidate) return candidate;
  }
  return before;
}

/**
 * `isoDate` at `hh:mm` Eastern wall-clock time as RFC 3339 with the offset in
 * force at that wall time, e.g. "2026-06-22T18:00:00-04:00" (seconds always
 * 00, no milliseconds, no "Z"). See wallOffsetMs for the DST edge cases.
 */
export function easternIso(isoDate: string, hh = 0, mm = 0): string {
  const offset = wallOffsetMs(Date.parse(`${addDays(isoDate, 0)}T${pad(hh)}:${pad(mm)}:00Z`));
  const minutes = Math.abs(offset) / 60_000;
  return `${isoDate}T${pad(hh)}:${pad(mm)}:00${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Midnight at the start of `isoDate` in America/New_York, e.g. "2026-06-15T00:00:00-04:00". */
export function easternMidnightIso(isoDate: string): string {
  return easternIso(isoDate);
}

/** The events.list window: Monday 00:00 Eastern through the next Monday 00:00 Eastern. */
export function calendarWeekWindow(monday: string): { timeMin: string; timeMax: string } {
  return { timeMin: easternMidnightIso(monday), timeMax: easternMidnightIso(addDays(monday, 7)) };
}

const dateInEastern = new Intl.DateTimeFormat("en-CA", {
  timeZone: CALENDAR_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Today's date in Eastern as YYYY-MM-DD. Not the runner's UTC date: GitHub
 * Actions cron is UTC and cannot follow DST, so a UTC "now" in an
 * Eastern-anchored week window is how off-by-one-day bugs get in.
 */
export function todayEastern(now: Date = new Date()): string {
  return dateInEastern.format(now);
}

export interface EventsListParams {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  singleEvents: boolean;
  pageToken?: string;
}

export interface CalendarEvent {
  id?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
}

export interface EventsPage {
  items?: CalendarEvent[] | null;
  nextPageToken?: string | null;
}

/** The read slice (attendanceCheck). */
export interface CalendarListService {
  events: { list(params: EventsListParams): Promise<{ data: EventsPage }> };
}

/** The slice of an Event body calendarCreate writes. */
export interface EventBody {
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
  description: string;
  location?: string;
}

/** The read + write slice (calendarCreate). */
export interface CalendarEventsService {
  events: CalendarListService["events"] & {
    delete(params: { calendarId: string; eventId: string }): Promise<unknown>;
    insert(params: { calendarId: string; requestBody: EventBody }): Promise<unknown>;
  };
}

/** Every event in the Eastern week starting `monday`, across all pages. */
export async function listWeekEvents(
  service: CalendarListService,
  calendarId: string,
  monday: string,
): Promise<CalendarEvent[]> {
  const window = calendarWeekWindow(monday);
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params: EventsListParams = { calendarId, ...window, singleEvents: true };
    if (pageToken) params.pageToken = pageToken;
    const { data } = await service.events.list(params);
    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}
