/**
 * Shared interface and helpers for every event parser. Rewrite (not a
 * byte-level port) of scripts/event_parsers/base.py.
 *
 * Every parser module in this directory exports one `parse` matching
 * {@link EventParser}: (raw content, weekStart, weekEnd, options) -> Event[].
 * Adding a new source means adding a module here and registering it in
 * index.ts -- nothing else needs to change.
 *
 * Dates are ISO `YYYY-MM-DD` strings throughout (inputs and the `date`
 * field), so window checks are plain string comparisons.
 *
 * Time zones: no date library. The parsers need exactly two zone operations
 * -- "UTC instant -> America/New_York wall clock" (luma, philly-ask-a-punk,
 * and offset-bearing ISO timestamps) and "offset-bearing ISO string ->
 * instant" -- and `Intl.DateTimeFormat` with `timeZone` plus `Date.parse`
 * cover both, DST transitions included, using the ICU data Node already
 * ships. Luxon would add a dependency for no extra correctness here.
 *
 * Failure semantics (the reason {@link ParseError} exists) are unchanged
 * from the Python: a page/feed whose overall shape is unrecognisable throws
 * ParseError, and Collection records the source as failed; a recognisable
 * page with nothing in the window returns []. New here: a single record
 * that is malformed (wrong JSON type, impossible hour or month) throws
 * {@link MalformedRecord}, which {@link collectRecords} catches, logs to
 * stderr and skips, so one bad row no longer fails the whole source.
 *
 * Divergences from the Python:
 *
 * - Element text is whitespace-normalised (`\s+` -> one space, then trimmed)
 *   instead of bs4's `get_text(strip=True)`, which strips each text node and
 *   glues them with no separator ("Featuring:<br>Links:" became
 *   "Featuring:Links:"). The normalised form keeps word boundaries between
 *   nodes but also collapses double spaces and non-breaking spaces inside
 *   one node.
 * - Offset-bearing timestamps (do215, gcal, lightbox) are converted to
 *   America/New_York, not shown as their own offset's wall clock. Identical
 *   for every real payload (each source already sends Eastern offsets); only
 *   a UTC or foreign-offset timestamp would now show Philadelphia time.
 * - A date-only ISO value where a timestamp was expected gives time "", not
 *   Python's fabricated "12:00 AM".
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { CheerioAPI } from "cheerio";

/** Any cheerio selection (cheerio's node type lives in a transitive package). */
type Selection = ReturnType<CheerioAPI>;

/** One collected event. Key order matches base.py's write_event (and so collect_week.py's JSON). */
export interface Event {
  title: string;
  venue: string;
  date: string;
  time: string;
  cost: string;
  url: string;
  description: string;
  venue_address?: string;
  venue_id?: string;
}

export interface ParserOptions {
  /** the-rotunda only: the `YYYY-MM-DD` used in the fetched URL's `?date=` param. */
  contextDate?: string;
}

export type EventParser = (raw: string, weekStart: string, weekEnd: string, options?: ParserOptions) => Event[];

/**
 * Raised when a parser can't recognise its source at all (no expected
 * containers, not JSON, not iCal). Distinct from "recognised, nothing in the
 * target week" (a valid empty result): this means the markup or API likely
 * changed and the parser needs updating, not that the week is quiet. The R5
 * Productions incident (a parser silently writing 0 events after a markup
 * change) is what this distinction guards against.
 */
export class ParseError extends Error {
  override name = "ParseError";
}

/** One record is unusable; {@link collectRecords} skips it with a warning. */
export class MalformedRecord extends Error {
  override name = "MalformedRecord";
}

/**
 * Builds an Event, trimming every field. `venue_address`/`venue_id` are
 * optional structured venue data for the few sources that supply it (do215's
 * venue object, philly-ask-a-punk's `place`). They're omitted when empty, not
 * written as "", so the normal no-metadata case doesn't change the shape of
 * every other source's output. merge_selections reads them off
 * _candidates.json; prepare_selection_input strips them from Selection's
 * per-day payloads.
 */
export function makeEvent(fields: Event): Event {
  const event: Event = {
    title: fields.title.trim(),
    venue: fields.venue.trim(),
    date: fields.date,
    time: fields.time.trim(),
    cost: fields.cost.trim(),
    url: fields.url.trim(),
    description: fields.description.trim(),
  };
  const address = fields.venue_address?.trim();
  if (address) event.venue_address = address;
  const venueId = fields.venue_id?.trim();
  if (venueId) event.venue_id = venueId;
  return event;
}

/**
 * Collects a description of every record {@link collectRecords} skips while
 * a callback runs: `skippedRecords.run([], fn)`, then read the array. Lets
 * collectWeek report partial skips per source without threading a logger
 * through every parser.
 */
export const skippedRecords = new AsyncLocalStorage<string[]>();

/**
 * Maps each item to its events (null/[] to skip), skipping and logging any
 * MalformedRecord. One bad record shouldn't fail a whole source -- but if
 * every record is malformed, that's a format change, not bad data, so it
 * throws ParseError. Otherwise a broken source would come back as an empty
 * "ok" one, and Collection's failed-vs-empty distinction would be lost (only
 * check_yield's floors would catch it, and several sources have a floor of 0).
 */
export function collectRecords<T>(source: string, items: Iterable<T>, toEvents: (item: T) => Event | Event[] | null): Event[] {
  const events: Event[] = [];
  let wellFormed = 0;
  let malformed = 0;
  let firstError = "";
  for (const item of items) {
    try {
      const result = toEvents(item);
      wellFormed++;
      if (Array.isArray(result)) events.push(...result);
      else if (result) events.push(result);
    } catch (err) {
      if (!(err instanceof MalformedRecord)) throw err;
      malformed++;
      firstError ||= err.message;
      console.warn(`${source}: skipping malformed record: ${err.message}`);
      skippedRecords.getStore()?.push(err.message);
    }
  }
  if (malformed > 0 && wellFormed === 0) {
    throw new ParseError(`${source}: all ${malformed} records malformed -- source format may have changed (first: ${firstError})`);
  }
  return events;
}

// --- HTML -------------------------------------------------------------------

export function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Whitespace-normalised text of the first matched element, or "". */
export function text(selection: Selection): string {
  return normalizeSpace(selection.first().text());
}

/** The first matched element's attribute, or "". */
export function attr(selection: Selection, name: string): string {
  return selection.first().attr(name) ?? "";
}

// --- JSON -------------------------------------------------------------------

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ParseError(`response isn't valid JSON: ${(err as Error).message}`);
  }
}

/**
 * A string field. Absent, null and false (WordPress ACF's "empty") read as "";
 * numbers are stringified (ids, prices). Anything else is a malformed record.
 */
export function str(obj: JsonObject, key: string): string {
  const value = obj[key];
  if (value === undefined || value === null || value === false) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new MalformedRecord(`"${key}" is ${JSON.stringify(value)}, expected a string`);
}

/** A nested object field; absent, null and false read as {}. */
export function obj(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined || value === null || value === false) return {};
  if (isObject(value)) return value;
  throw new MalformedRecord(`"${key}" is ${JSON.stringify(value)}, expected an object`);
}

export function requireObject(item: unknown): JsonObject {
  if (!isObject(item)) throw new MalformedRecord(`record is ${JSON.stringify(item)}, expected an object`);
  return item;
}

// --- Dates and times --------------------------------------------------------

/** `YYYY-MM-DD` for a real calendar date, or null (e.g. Feb 30, month 13). */
export function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

/** Like {@link isoDate}, but a record-level error instead of null. */
export function requireDate(year: number, month: number, day: number): string {
  const date = isoDate(year, month, day);
  if (date === null) throw new MalformedRecord(`no such date ${year}-${month}-${day}`);
  return date;
}

/** Validates a leading `YYYY-MM-DD` (anything may follow, e.g. a time). */
export function leadingIsoDate(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

export function inWeek(date: string, weekStart: string, weekEnd: string): boolean {
  return weekStart <= date && date <= weekEnd;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Month number from a name or abbreviation ("Sept", "OCT", "January"), or null. */
export function parseMonth(name: string): number | null {
  const index = MONTHS.indexOf(name.trim().toLowerCase().slice(0, 3));
  return index === -1 ? null : index + 1;
}

const DAY_MS = 86_400_000;

/**
 * Picks whichever nearby year puts (month, day) closest to weekStart, for
 * sources whose date text has no year. Assuming weekStart's year breaks
 * across Dec/Jan: weekStart 2026-12-28 with "Jan 3" must be 2027, or the
 * event lands a year in the past and silently drops out of the window.
 * Tries weekStart's year and both neighbours; null only if (month, day)
 * isn't a date in any of them (Feb 29 outside a leap year).
 */
export function resolveYear(month: number, day: number, weekStart: string): number | null {
  const start = Date.parse(weekStart);
  const startYear = Number(weekStart.slice(0, 4));
  let best: { year: number; distance: number } | null = null;
  for (const year of [startYear - 1, startYear, startYear + 1]) {
    const date = isoDate(year, month, day);
    if (date === null) continue;
    const distance = Math.abs(Date.parse(date) - start) / DAY_MS;
    if (best === null || distance < best.distance) best = { year, distance };
  }
  return best?.year ?? null;
}

/** "7:05 PM" from a 24-hour clock. Throws MalformedRecord on an impossible time. */
export function formatTime(hour: number, minute: number): string {
  if (!(Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) {
    throw new MalformedRecord(`no such time ${hour}:${minute}`);
  }
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

/** 24-hour clock from a 12-hour reading ("7", "pm" -> 19). */
export function to24Hour(hour: number, meridiem: string): number {
  return (hour % 12) + (meridiem.toLowerCase().startsWith("p") ? 12 : 0);
}

export interface LocalDateTime {
  date: string;
  time: string;
}

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Philadelphia wall-clock date and time for an instant (epoch milliseconds). */
export function easternDateTime(epochMs: number): LocalDateTime {
  if (!Number.isFinite(epochMs)) throw new MalformedRecord(`not a timestamp: ${epochMs}`);
  const parts: Record<string, string> = {};
  for (const { type, value } of EASTERN.formatToParts(epochMs)) parts[type] = value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: formatTime(Number(parts.hour), Number(parts.minute)),
  };
}

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parses an ISO 8601 date or date-time. An offset (or Z) means an instant,
 * shown in Philadelphia time; no offset means the wall clock as written; a
 * bare date gives time "". Null if the string isn't ISO-shaped at all;
 * MalformedRecord if it is but names an impossible date or time.
 */
export function parseIsoDateTime(value: string): LocalDateTime | null {
  const m = ISO_DATETIME.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offset] = m;
  const date = requireDate(Number(y), Number(mo), Number(d));
  if (h === undefined || mi === undefined) return { date, time: "" };
  const time = formatTime(Number(h), Number(mi));
  if (offset === undefined) return { date, time };
  const normalisedOffset = offset === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
  return easternDateTime(Date.parse(`${date}T${h}:${mi}:${s ?? "00"}${normalisedOffset}`));
}
