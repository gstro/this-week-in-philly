/**
 * do215 -- Do215.com's undocumented day-page JSON API. Rewrite of
 * scripts/event_parsers/do215.py.
 *
 * Not the site's HTML at all: `https://do215.com/events/YYYY/M/D.json` (no
 * zero-padding on month/day) returns `{"events": [...], "paging": {...}}`,
 * confirmed live 2026-07-29. Replaced a model-reads-fetch_page_text approach
 * that needed one Chromium page load per day and, under budget pressure, was
 * one of several sources observed writing a plausible-looking empty file
 * instead of running the documented fetch at all (see check_yield's docs).
 *
 * Two API quirks this parser exists specifically to handle:
 *
 * - `begin_time` carries the wrong UTC offset (confirmed -05:00 in August,
 *   when Philadelphia is on -04:00 EDT); `tz_adjusted_begin_date` has the
 *   correct one. Always use the latter for both date and time.
 * - Day pages inject stale "featured" events from unrelated dates (observed:
 *   a June listing bleeding into an August day page) -- the URL's day is not
 *   reliable, so every event is filtered on its own `tz_adjusted_begin_date`,
 *   never on which day-page it came from, and deduped by `id`.
 *
 * `venue` is a full object, not a string -- confirmed live 2026-08-30:
 *
 *     {"id": 511812, "title": "Nikki Lopez", "permalink": "/venues/nikki-lopez",
 *      "address": "304 South St, Philadelphia, PA 19147", "city": "Philadelphia",
 *      "state": "PA", "zip": "19147", "latitude": null, "capacity": false}
 *
 * `id` is always present and address-stable (0 of 145 ids varied across one
 * real week), and `address` is present for ~78% of venues. What the object
 * does NOT carry is any quality signal: `latitude` was null on 145/145
 * venues, `capacity` false on 145/145, `popularity` 1.0 on 142/145. There is
 * no API-side marker separating a genuinely bad title from an
 * unusual-sounding real one -- venue 511812's "Nikki Lopez" reads like a
 * person's name but is a real DIY venue at 304 South St (a plain venue name
 * in this project's real weekly reports since 2026-06-10, per
 * docs/v1/Data/event-picks-log.csv), which is why the address is appended to
 * the title rather than the title being classified or replaced (see below).
 *
 * `is_ongoing: true` marks recurring "every day"-style listings, which the
 * source's prior model-driven instructions already filtered out by hand; this
 * parser drops them the same way.
 *
 * collect_source owns the multi-day, multi-page fetch loop and hands this
 * parser one merged `{"events": [...]}` blob (every day/page response has the
 * same shape, so concatenating their `events` lists is safe); this function
 * makes no network calls.
 *
 * Divergences from the Python:
 *
 * - A null or missing event title skips the event with a warning (Python
 *   wrote the title "None"); a null venue title or permalink reads as ""
 *   (Python wrote "None" and "https://do215.comNone").
 * - Casing comparisons use toLowerCase, not casefold.
 * - A non-object event or venue skips that event with a warning (a non-object
 *   venue crashed the whole source).
 */

import { type Event, type EventParser, type JsonObject, MalformedRecord, ParseError, collectRecords, inWeek, isObject, makeEvent, obj, parseIsoDateTime, parseJson, requireObject, str } from "./base.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A single display-and-key-ready street address from the venue object, or "".
 *
 * The API's `address` is inconsistent: absent, null (venue 502134, Spruce
 * Street Harbor), "" (510458), bare street with no locality ("1200 Callowhill
 * St"), already locality-bearing ("304 South St, Philadelphia, PA 19147"),
 * space-padded, or ALL-CAPS. `city`/`state`/`zip` are separate fields and are
 * usually present even when `address` is not.
 *
 * So: use `address` as-is when it already carries locality, otherwise append
 * whichever of city/state/zip exist. Deliberately NOT `full_address`, which
 * doubles the locality when `address` already has it -- venue 511812's is
 * "304 South St, Philadelphia, PA 19147, Philadelphia, PA, 19147".
 *
 * Composing locality in matters downstream: check_selection's
 * check_outside_philadelphia() skips address-less picks on purpose, and bare
 * streets would turn those deliberate skips into false warnings.
 */
export function venueAddress(venue: JsonObject): string {
  const raw = str(venue, "address").trim();
  if (!raw) return "";
  const zip = str(venue, "zip").trim();
  const state = str(venue, "state").trim();
  const city = str(venue, "city").trim();
  const hasLocality =
    (zip !== "" && raw.includes(zip)) || (state !== "" && new RegExp(`\\b${escapeRegExp(state)}\\b`, "i").test(raw));
  if (hasLocality) return raw;
  const tail = [city, `${state} ${zip}`.trim()].filter(Boolean).join(", ");
  return tail ? `${raw}, ${tail}` : raw;
}

/**
 * Appends the address to the venue title rather than replacing it. Some
 * Do215 titles read oddly out of context ("Nikki Lopez", six unrelated shows
 * at 304 South St), but that's a real, distinctively-named DIY venue, the
 * same category as "Johnny Brenda's". No available test separates an
 * unusually-named real venue from a bad title: the API has no quality signal,
 * and a "looks like a person's name" rule fires on 57 of 312 real venue
 * strings, Nikki Lopez and Spruce Street Harbor included. Preferring the
 * address outright would erase recognisable names (City Winery, Union
 * Transfer, Underground Arts) on every record that has one. Appending can't
 * make a card worse; at most it's occasionally redundant.
 *
 * Skips the prefix when the address just restates the title (venue 514514,
 * "Upper Merion Township Building Park"), which would otherwise render twice.
 */
function venueDisplay(venue: JsonObject, address: string): string {
  const title = str(venue, "title").trim();
  if (address) {
    return !title || address.toLowerCase().startsWith(title.toLowerCase()) ? address : `${title}, ${address}`;
  }
  const city = str(venue, "city");
  const state = str(venue, "state");
  if (city && state) return `${title}, ${city}, ${state}`;
  if (city) return `${title}, ${city}`;
  return title;
}

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!isObject(payload) || !("events" in payload)) {
    throw new ParseError("response has no top-level 'events' key -- API shape may have changed");
  }
  const rawEvents = payload.events;
  if (!Array.isArray(rawEvents)) throw new ParseError("'events' is not a list -- API shape may have changed");

  const seenIds = new Set<unknown>();
  return collectRecords("do215", rawEvents as unknown[], (entry): Event | null => {
    const item = requireObject(entry);
    const id = item.id;
    if (id !== undefined && id !== null) {
      if (seenIds.has(id)) return null; // stale "featured" entries repeat across day pages
      seenIds.add(id);
    }
    if (item.is_ongoing) return null;

    const start = parseIsoDateTime(str(item, "tz_adjusted_begin_date"));
    if (start === null || !inWeek(start.date, weekStart, weekEnd)) return null;

    const title = str(item, "title");
    if (!title.trim()) throw new MalformedRecord(`event ${String(id)} has no title`);
    const venue = obj(item, "venue");
    const address = venueAddress(venue);
    const permalink = str(item, "permalink");
    return makeEvent({
      title,
      venue: venueDisplay(venue, address),
      date: start.date,
      time: start.time,
      cost: item.is_free ? "Free" : str(item, "ticket_info"),
      url: permalink ? `https://do215.com${permalink}` : "",
      description: str(item, "excerpt"),
      venue_address: address,
      venue_id: str(venue, "id"),
    });
  });
};
