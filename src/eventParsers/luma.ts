/**
 * luma-ical -- Luma's Philadelphia discover feed (UTC DTSTART). Rewrite of
 * scripts/event_parsers/luma.py.
 *
 * DTSTART is UTC; it's converted to America/New_York per instant (the Python
 * once hardcoded -4h with no DST branch, an hour off from November to March).
 * A URL-only LOCATION is an online event: the URL becomes `url` and the venue
 * a placeholder.
 *
 * Unlike the HTML parsers, zero VEVENTs is a valid result: an empty calendar
 * is well-formed iCal, and this feed's volume (15-20 events across ~4 weeks)
 * means a short window really can be empty. Only a response that isn't iCal
 * at all (an error page) throws ParseError.
 *
 * Divergences from the Python: an impossible DTSTART (month 13, hour 25)
 * skips that event with a warning instead of failing the source; iCal
 * unescaping/unfolding fixes are in ical.ts.
 */

import { type Event, type EventParser, MalformedRecord, ParseError, collectRecords, easternDateTime, formatTime, inWeek, makeEvent, requireDate } from "./base.js";
import { parseVEvents, unescapeText } from "./ical.js";

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  if (!raw.includes("BEGIN:VCALENDAR")) {
    throw new ParseError("response doesn't look like an iCal feed at all (no BEGIN:VCALENDAR) -- feed may have changed");
  }
  return collectRecords("luma-ical", parseVEvents(raw), (item): Event | null => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(item.DTSTART ?? "");
    if (!m) return null;
    const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
    requireDate(year, month, day);
    formatTime(hour, minute); // validates
    if (second > 59) throw new MalformedRecord(`no such second ${second}`);
    const local = easternDateTime(Date.UTC(year, month - 1, day, hour, minute, second));
    if (!inWeek(local.date, weekStart, weekEnd)) return null;

    const location = unescapeText(item.LOCATION ?? "");
    const online = location.startsWith("http");
    return makeEvent({
      title: unescapeText(item.SUMMARY ?? ""),
      venue: online ? "(online / see description)" : location,
      date: local.date,
      time: local.time,
      cost: "",
      url: online ? location : "",
      description: unescapeText(item.DESCRIPTION ?? ""),
    });
  });
};
