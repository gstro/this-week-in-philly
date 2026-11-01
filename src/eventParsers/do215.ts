/**
 * do215 -- Do215.com's day listings, read from the SvelteKit data endpoint
 * the rebuilt site serves them through.
 *
 * History. Until 2026-10-25 this read `https://do215.com/events/YYYY/M/D.json`
 * (an undocumented JSON API; `{"events": [...], "paging": {...}}`). Do215
 * replaced its platform between that run and the 2026-11-01 one and the old
 * route now 404s for every date, which is how the week of 2026-11-02 went out
 * with Do215 `failed` and 178 events instead of ~500-680. The replacement is
 * `https://do215.com/events/YYYY/M/D/__data.json[?page=N]` (no zero-padding
 * on month/day, 20 events a page), confirmed live 2026-11-01: SvelteKit's
 * `devalue` wire format (see lib/devalue.ts), whose decoded root holds
 * `browse: {data: [{date, events: [...]}], _meta: {total, total_pages, ...}}`.
 * A page past `total_pages` answers 200 with no events, so the collector loops
 * on `_meta.total_pages`, never on "until empty".
 *
 * Shape of an event (week of 2026-11-02, 523 of them):
 *
 *     {"id": 17825109, "type": "event", "title": "Taylor Tomlinson",
 *      "permalink": "/events/2026/11/2/taylor-tomlinson-tickets",
 *      "event_type": "single_day", "occurrence_date": "2026-11-02",
 *      "tz_adjusted_begin_time": "2026-11-02T18:30:00-05:00",
 *      "tz_adjusted_end_time": null, "category": "Comedy", "genres": [],
 *      "venue": {"id": 489710, "title": "Helium Comedy Club",
 *                "district_name": "Rittenhouse Square", "area_name": "Center City", ...}}
 *
 * Rules this parser exists to apply (all found by surveying that week):
 *
 * - The event's date is `occurrence_date`, never the date inside
 *   `tz_adjusted_begin_time`. For a `weekly_repeating` event ("Every Monday")
 *   the latter is the *series start* (May 2026, or October 2025), and for a
 *   `multi_day` event it is the run's first day; filtering on it would drop
 *   every recurring listing. Only the wall-clock time is taken from it (the
 *   offset is real, unlike the old API's `begin_time`; do not use `begin_time`,
 *   which is UTC).
 * - `multi_day` is the old `is_ongoing`: STRANGER THINGS (Oct 1 - Dec 31) was
 *   listed on all seven days of the week. A multi_day run that covers the
 *   whole target week is dropped, as before. A shorter one (a festival that
 *   ends Wednesday) is kept once, on its first in-window day, deduped by id.
 * - `weekly_repeating` occurrences are kept, one per `occurrence_date`: like
 *   the museum tour the old API re-listed daily, they are real dated
 *   listings, and prepare_selection_input's recurring-listing grouping is what
 *   deals with them, not Collection.
 * - Otherwise an event is deduped on (id, occurrence_date), so a repeat of the
 *   same listing within a day collapses but a daily event is not reduced to
 *   one day (the old parser deduped on id alone).
 *
 * What the new payload no longer carries, accepted 2026-11-01: ticket price
 * and "free" (`cost` is always ""), the description/excerpt, and the venue's
 * street address, city and state. `venue` is therefore the bare venue title,
 * and `venue_address` is never set -- check_selection's outside-Philadelphia
 * check skips address-less picks on purpose, so suburban listings are no
 * longer flagged. `venue_id` is still sent and still address-stable (the 604
 * ids committed in data/2026-*\/do215.json carry over), so an id -> address
 * lookup table built from those weeks is the route back to addresses; it does
 * not exist yet. To keep some signal for Selection, `description` is now
 * "<category> (<genres>) · <area>, <district>", e.g.
 * "Music (Indie & Alternative) · Center City, Rittenhouse Square".
 *
 * The prior address-bearing venue string also fed prepare_selection_input's
 * (title, venue) keys and the _recent_picks repeat check, so for a week or two
 * a Do215 venue spelled "Helium Comedy Club" will not match the same venue
 * picked earlier as "Helium Comedy Club, 2031 Sansom St, Philadelphia, PA
 * 19103". Cross-source dedup keys on (date, title) and is unaffected.
 *
 * collect_source owns the multi-day, multi-page fetch loop. It uses
 * {@link decodeDayPage} on each response and hands this parser one merged
 * `{"events": [...]}` blob; this function makes no network calls.
 *
 * Divergences from the retired Python (which is no longer maintained for this
 * source): a null or missing event title skips the event with a warning, a
 * null venue title or permalink reads as "", and a non-object event or venue
 * skips that event.
 */

import { unflatten } from "../lib/devalue.js";
import {
  type Event,
  type EventParser,
  type JsonObject,
  MalformedRecord,
  ParseError,
  collectRecords,
  inWeek,
  isObject,
  makeEvent,
  obj,
  parseIsoDateTime,
  parseJson,
  requireObject,
  str,
} from "./base.js";

export interface DayPage {
  events: unknown[];
  totalPages: number;
}

/**
 * The events and page count out of one `__data.json` response. Throws
 * ParseError when the response isn't recognisably that -- the collector
 * records that as a failed request, so a site change that breaks every page
 * still ends in "every request failed" rather than an empty "ok" source.
 */
export function decodeDayPage(payload: unknown): DayPage {
  if (!isObject(payload) || !Array.isArray(payload.nodes)) {
    throw new ParseError("response isn't a SvelteKit data payload (no 'nodes' array) -- site may have changed");
  }
  for (const node of payload.nodes as unknown[]) {
    if (!isObject(node) || node.type !== "data" || !Array.isArray(node.data)) continue;
    let root: unknown;
    try {
      root = unflatten(node.data);
    } catch (err) {
      throw new ParseError(`couldn't decode the page data: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isObject(root) || !isObject(root.browse)) continue;

    const browse = root.browse;
    const meta = browse._meta;
    const groups = browse.data;
    if (!Array.isArray(groups) || !isObject(meta)) {
      throw new ParseError("'browse' has no data/_meta -- site may have changed");
    }
    const totalPages = meta.total_pages;
    if (typeof totalPages !== "number" || !Number.isInteger(totalPages) || totalPages < 0) {
      throw new ParseError("'browse._meta.total_pages' isn't a whole number -- site may have changed");
    }
    const events: unknown[] = [];
    for (const group of groups as unknown[]) {
      if (!isObject(group) || !Array.isArray(group.events)) {
        throw new ParseError("a 'browse.data' group has no events list -- site may have changed");
      }
      events.push(...(group.events as unknown[]));
    }
    return { events, totalPages };
  }
  throw new ParseError("no data node carries 'browse' -- site may have changed");
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function description(item: JsonObject, venue: JsonObject): string {
  const category = str(item, "category").trim();
  const genres = Array.isArray(item.genres) ? item.genres.filter((g): g is string => typeof g === "string" && g.trim() !== "") : [];
  const area = str(venue, "area_name").trim();
  const district = str(venue, "district_name").trim();
  let text = category;
  if (genres.length > 0) text += `${text ? " " : ""}(${genres.join(", ")})`;
  const where = [area, district].filter(Boolean).join(", ");
  if (where) text += `${text ? " · " : ""}${where}`;
  return text;
}

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!isObject(payload) || !("events" in payload)) {
    throw new ParseError("response has no top-level 'events' key -- API shape may have changed");
  }
  const rawEvents = payload.events;
  if (!Array.isArray(rawEvents)) throw new ParseError("'events' is not a list -- API shape may have changed");

  const seen = new Set<string>();
  return collectRecords("do215", rawEvents as unknown[], (entry): Event | null => {
    const item = requireObject(entry);
    const eventType = str(item, "event_type");

    const date = str(item, "occurrence_date");
    if (!ISO_DAY.test(date)) throw new MalformedRecord(`event ${str(item, "id")} has no usable occurrence_date`);
    if (!inWeek(date, weekStart, weekEnd)) return null;

    const start = parseIsoDateTime(str(item, "tz_adjusted_begin_time"));
    if (eventType === "multi_day") {
      const end = parseIsoDateTime(str(item, "tz_adjusted_end_time"));
      // A run covering the whole week is an ongoing exhibit, not an event.
      if (end === null || ((start === null || start.date <= weekStart) && end.date >= weekEnd)) return null;
    }

    const id = str(item, "id");
    if (id) {
      const key = eventType === "multi_day" ? id : `${id}|${date}`;
      if (seen.has(key)) return null;
      seen.add(key);
    }

    const title = str(item, "title");
    if (!title.trim()) throw new MalformedRecord(`event ${id} has no title`);
    const venue = obj(item, "venue");
    const permalink = str(item, "permalink");
    return makeEvent({
      title,
      venue: str(venue, "title"),
      date,
      time: start?.time ?? "",
      cost: "",
      url: permalink ? `https://do215.com${permalink}` : "",
      description: description(item, venue),
      venue_id: str(venue, "id"),
    });
  });
};
