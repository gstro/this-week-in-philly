/**
 * meetup-ical -- shared parser for all 8 Meetup group iCal feeds
 * (`DTSTART;TZID=America/New_York`, so DTSTART is already Philadelphia wall
 * time). Rewrite of scripts/event_parsers/meetup.py.
 *
 * As with luma.ts, zero VEVENTs is valid -- several of these groups are
 * genuinely quiet for weeks -- and only a non-iCal response throws.
 * A missing or URL-only LOCATION is reported as "(online)".
 *
 * Divergences from the Python: an impossible hour/minute skips that event
 * with a warning (Python's datetime.time() raised and failed the whole
 * source); iCal unescaping/unfolding fixes are in ical.ts.
 */

import { type Event, type EventParser, ParseError, collectRecords, formatTime, inWeek, isoDate, makeEvent } from "./base.js";
import { parseVEvents, unescapeText } from "./ical.js";

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  if (!raw.includes("BEGIN:VCALENDAR")) {
    throw new ParseError("response doesn't look like an iCal feed at all (no BEGIN:VCALENDAR) -- feed may have changed");
  }
  return collectRecords("meetup-ical", parseVEvents(raw), (item): Event | null => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(item.DTSTART ?? "");
    if (!m) return null;
    const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
    const date = isoDate(year, month, day);
    if (date === null || !inWeek(date, weekStart, weekEnd)) return null;

    const location = unescapeText(item.LOCATION ?? "");
    const online = !location || location.startsWith("http");
    return makeEvent({
      title: unescapeText(item.SUMMARY ?? ""),
      venue: online ? "(online)" : location,
      date,
      time: formatTime(hour, minute),
      cost: "",
      url: item.URL ?? "",
      description: unescapeText(item.DESCRIPTION ?? ""),
    });
  });
};
