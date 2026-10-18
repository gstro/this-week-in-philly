/**
 * wxpn -- WXPN's concert calendar, via the Modern Tribe Events REST API on
 * xpn.org (`/wp-json/tribe/events/v1/events`), not the public
 * xpn.org/concert-and-events/ page. Rewrite of scripts/event_parsers/wxpn.py.
 *
 * The site used to be read from `backend.xpn.org/wp-json/wp/v2/event`; that
 * host stopped serving (its Pantheon site was removed -- the TLS certificate
 * no longer covers the hostname and the origin answers "404 - Unknown site"),
 * and the first failed run was 2026-09-28. The calendar moved to The Events
 * Calendar plugin on xpn.org itself, confirmed live 2026-10-18.
 *
 * API quirks:
 *
 * - Unlike the old endpoint, this one filters server-side: `start_date` and
 *   `end_date` bound the window, so the collector fetches only the target
 *   week. `per_page` is capped at 50 (a larger value is silently clamped), and
 *   the response is an object (`events`, `total`, `total_pages`), which the
 *   collector flattens into the bare array this parser takes.
 * - Most events are `all_day` with a "00:00:00" start -- a date, not a
 *   showtime -- so time is left blank for those. A few (the Free At Noon
 *   series) carry a real start time, which is surfaced.
 * - Titles, venue names and the `website` ticket link are HTML-escaped
 *   ("Ortlieb&#8217;s", "&amp;" in query strings), so they're entity-decoded.
 * - `venue` is an object when set and an empty array when not.
 * - The "Philadelphia Area" category is on nearly every event, so it carries
 *   no signal; the remaining categories ("WXPN Welcomes", "Free At Noon",
 *   "Central PA") become the description.
 *
 * Divergences from the Python: a malformed record (wrong JSON types) is
 * skipped with a warning instead of crashing the whole source.
 */

import { decodeHTML } from "entities";
import { type Event, type EventParser, ParseError, collectRecords, formatTime, inWeek, isObject, leadingIsoDate, makeEvent, parseJson, requireObject, str } from "./base.js";

const NOISE_CATEGORY = "Philadelphia Area";

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!Array.isArray(payload)) throw new ParseError("response is not a JSON array of events -- API shape may have changed");

  return collectRecords("wxpn", payload as unknown[], (entry): Event | null => {
    const item = requireObject(entry);
    const start = str(item, "start_date");
    const date = leadingIsoDate(start);
    if (date === null || !inWeek(date, weekStart, weekEnd)) return null;

    const venue = isObject(item["venue"]) ? decodeHTML(str(item["venue"], "venue")) : "";
    const clock = /[ T](\d{2}):(\d{2})/.exec(start);
    const time = item["all_day"] || clock === null ? "" : formatTime(Number(clock[1]), Number(clock[2]));
    const categories = (Array.isArray(item["categories"]) ? (item["categories"] as unknown[]) : [])
      .filter(isObject)
      .map((category) => decodeHTML(str(category, "name")))
      .filter((name) => name !== "" && name !== NOISE_CATEGORY);

    return makeEvent({
      title: decodeHTML(str(item, "title")),
      venue,
      date,
      time,
      cost: str(item, "cost"),
      url: str(item, "url") || decodeHTML(str(item, "website")),
      description: categories.join(", "),
    });
  });
};
