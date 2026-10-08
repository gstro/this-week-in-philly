/**
 * gcal -- Google Calendar API event resources into the Collection schema.
 * Rewrite of scripts/event_parsers/gcal.py.
 *
 * Covers the three venue calendars collect_source fetches (Iffy Books,
 * Wooden Shoe Books, Trakt.tv film releases).
 *
 * Exists because of a real, silent data-loss incident. On 2026-08-01 the
 * Collection Routine improvised a one-off script to convert
 * `gcal_list_events` MCP responses into source JSON, and that script dropped
 * the `url` field on every event it wrote -- all 15 events across the three
 * calendars came out with `"url": ""`, where the pre-existing baseline (git
 * 728633b) had real URLs. Nothing caught it: the events were otherwise
 * well-formed, the counts were right, and check_yield's floors are
 * count-based. This module is the tested replacement, and `url` is asserted
 * in its tests.
 *
 * Google returns two shapes for `start`, and both occur in these calendars:
 * `dateTime` (a timed event, RFC 3339 with offset) and `date` (an all-day
 * event, bare YYYY-MM-DD). Trakt.tv releases are all-day; Iffy Books and
 * Wooden Shoe are timed. All-day events get an empty `time` rather than a
 * fabricated midnight -- the same choice wxpn makes. `venue` and
 * `fallback_url` on the payload are supplied by the collector and describe
 * the calendar as a whole.
 *
 * Divergences from the Python: a non-object `start` skips that event with a
 * warning (it crashed the whole source); timed events are shown in
 * Philadelphia time (base.ts) -- identical in practice, since the collector
 * requests timeZone=America/New_York.
 */

import { type Event, type EventParser, ParseError, collectRecords, inWeek, isObject, makeEvent, obj, parseIsoDateTime, parseJson, requireObject, str } from "./base.js";

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!isObject(payload) || !("items" in payload)) {
    throw new ParseError("response has no top-level 'items' key -- Calendar API shape may have changed");
  }
  const items = payload.items;
  if (!Array.isArray(items)) throw new ParseError("'items' is not a list -- Calendar API shape may have changed");
  let defaultVenue: string;
  let fallbackUrl: string;
  try {
    defaultVenue = str(payload, "venue");
    fallbackUrl = str(payload, "fallback_url");
  } catch (err) {
    // Payload-level, not per-record: the wrapper collect_source builds is malformed.
    throw new ParseError(`gcal payload: ${err instanceof Error ? err.message : String(err)}`);
  }

  return collectRecords("gcal", items as unknown[], (entry): Event | null => {
    const item = requireObject(entry);
    if (item.status === "cancelled") return null;
    const startObj = obj(item, "start");
    const start = parseIsoDateTime(str(startObj, "dateTime") || str(startObj, "date"));
    if (start === null || !inWeek(start.date, weekStart, weekEnd)) return null;

    return makeEvent({
      title: str(item, "summary"),
      venue: str(item, "location") || defaultVenue,
      date: start.date,
      time: start.time,
      cost: "",
      // htmlLink is present on every real event resource; the venue's own
      // site keeps `url` from ever being silently empty -- the regression
      // this module guards.
      url: str(item, "htmlLink") || fallbackUrl,
      description: str(item, "description"),
    });
  });
};
