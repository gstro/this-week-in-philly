/**
 * wxpn -- WXPN's own WordPress REST API (backend.xpn.org), not the public
 * xpn.org/concert-and-events/ page. Rewrite of scripts/event_parsers/wxpn.py.
 *
 * That public page is Next.js RSC (`self.__next_f` payload chunks) with zero
 * event data in its raw HTML -- confirmed live 2026-07-29 -- which is why
 * this source needed a full Chromium render before. The site's own JS bundle
 * calls `https://backend.xpn.org/wp-json/wp/v2/event` directly; that endpoint
 * is public, paginated, and returns structured JSON with no model in the loop.
 *
 * Two API quirks:
 *
 * - `per_page` is capped at 100 (a value above that 400s), and results are
 *   sorted by WordPress publish date, not the event's own date -- an event in
 *   next week's window could be on any page. There's no server-side way to
 *   sort or filter by the ACF event date, so the collector fetches every page
 *   (bounded by `X-WP-Total-Pages`, capped defensively) and this parser
 *   filters client-side on `acf.date`.
 * - `acf.date` is a full "YYYY-MM-DD HH:MM:SS" string, but the time portion
 *   is always "00:00:00" in every record observed (2026-07-29) -- a date, not
 *   a showtime. Time is left blank rather than reporting a fake midnight.
 *
 * WordPress HTML-escapes `title.rendered` (and ACF text fields), so they're
 * entity-decoded.
 *
 * Divergences from the Python: a non-object `acf` or `title` skips that event
 * with a warning (it crashed the whole source).
 */

import { decodeHTML } from "entities";
import { type Event, type EventParser, ParseError, collectRecords, inWeek, leadingIsoDate, makeEvent, obj, parseJson, requireObject, str } from "./base.js";

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!Array.isArray(payload)) throw new ParseError("response is not a JSON array of posts -- API shape may have changed");

  return collectRecords("wxpn", payload as unknown[], (entry): Event | null => {
    const item = requireObject(entry);
    const acf = obj(item, "acf");
    const date = leadingIsoDate(str(acf, "date"));
    if (date === null || !inWeek(date, weekStart, weekEnd)) return null;

    return makeEvent({
      title: decodeHTML(str(obj(item, "title"), "rendered")),
      venue: decodeHTML(str(acf, "venue")),
      date,
      time: "",
      cost: str(acf, "price"),
      url: str(item, "link") || str(acf, "external_link"),
      description: decodeHTML(str(acf, "external_artist")),
    });
  });
};
