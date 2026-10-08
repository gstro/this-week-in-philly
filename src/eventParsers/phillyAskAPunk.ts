/**
 * philly-ask-a-punk -- JSON API of a Gancio (federated events platform)
 * instance. Rewrite of scripts/event_parsers/philly_ask_a_punk.py.
 *
 * `start_datetime`/`end_datetime` are Unix seconds, converted to
 * America/New_York per instant (the Python once hardcoded -4h with no DST
 * branch). `multidate` events count as in the week if their span overlaps it.
 *
 * When the feed has no real place it sets `place.name` and `place.address`
 * to the same string, which used to render as "ask a punk (ask a punk)" and,
 * with no Selection-authored address to key on, collapsed to the degenerate
 * venue key `askapunkaskapunk` in check_selection. The name is emitted once
 * in that case and no venue_address is written; a useless key is better than
 * a misleading one.
 *
 * Divergences from the Python:
 *
 * - Event URLs are `https://philly.askapunk.net/event/<slug>`. Python builds
 *   `/<slug>`, which 404s: checked live on 2026-10-07, `/event/<slug>`
 *   returned 200 and `/<slug>` 404 for the same event.
 * - `tags` given as a single string is used as-is (Python joined its
 *   characters: "p / u / n / k"); non-string array entries are dropped.
 * - A non-object event, or a non-numeric `start_datetime`, skips that event
 *   with a warning (both crashed the whole source).
 * - A multidate event that began before the week is dated `weekStart` (its
 *   first in-week day) with a blank time, instead of keeping its pre-week
 *   start date -- which put an "in-week" event on a day outside the week.
 * - A null title or slug reads as "" (Python wrote "None").
 */

import { type Event, type EventParser, MalformedRecord, ParseError, collectRecords, easternDateTime, makeEvent, obj, parseJson, requireObject, str } from "./base.js";

function tagList(tags: unknown): string {
  if (typeof tags === "string") return tags;
  if (!Array.isArray(tags)) return "";
  return tags.filter((t): t is string => typeof t === "string").join(" / ");
}

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!Array.isArray(payload)) throw new ParseError("expected a JSON array of events at the top level");

  return collectRecords("philly-ask-a-punk", payload as unknown[], (entry): Event | null => {
    const item = requireObject(entry);
    const startTs = item.start_datetime;
    if (startTs === undefined || startTs === null) return null;
    if (typeof startTs !== "number") throw new MalformedRecord(`start_datetime is ${JSON.stringify(startTs)}`);
    const start = easternDateTime(startTs * 1000);

    let date = start.date;
    let time = start.time;
    const endTs = item.end_datetime;
    if (item.multidate && typeof endTs === "number" && endTs) {
      const endDate = easternDateTime(endTs * 1000).date;
      if (start.date > weekEnd || endDate < weekStart) return null;
      if (start.date < weekStart) {
        date = weekStart;
        time = "";
      }
    } else if (start.date < weekStart || start.date > weekEnd) {
      return null;
    }

    const place = obj(item, "place");
    const venueName = str(place, "name").trim();
    let venueAddress = str(place, "address").trim();
    let venue = venueName;
    if (venueAddress && venueAddress.toLowerCase() !== venueName.toLowerCase()) {
      venue = `${venueName} (${venueAddress})`;
    } else {
      venueAddress = "";
    }

    return makeEvent({
      title: str(item, "title"),
      venue,
      date,
      time,
      cost: "",
      url: `https://philly.askapunk.net/event/${str(item, "slug")}`,
      description: tagList(item.tags),
      venue_address: venueAddress,
    });
  });
};
