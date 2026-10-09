/**
 * philadelphia-film-society -- Fandango's rendered showtime text for PFS's 3
 * venues (Film Society Center, Bourse Theater, East Theater). Rewrite of
 * scripts/event_parsers/philadelphia_film_society.py.
 *
 * Fandango's theater page has no server-rendered showtime data at all (no
 * JSON-LD `ScreeningEvent`, nothing in the raw HTML -- confirmed live
 * 2026-08-01) and Agile Ticketing, the actual backend Fandango's own JSON-LD
 * names for these venues, is Incapsula-WAF-blocked domain-wide (confirmed
 * live 2026-08-01, the same shape of block as filmadelphia.org's own WAF). A
 * real browser is unavoidable for this source. But the browser's rendered
 * text is cleanly, consistently structured per film, confirmed against all 3
 * venues' real pages:
 *
 *     [Title]
 *
 *     Rated:
 *     [Rating]
 *     Runtime:
 *     [X hr Y min]
 *
 *     Standard
 *     [Format label]
 *     [time1]
 *     [time2]
 *     ...
 *
 * This module only ever receives already-rendered text, merged by the
 * collector into `[{venue_name, venue_address, theater_url, context_date,
 * rendered_text}]` -- a pure text -> Event transform even though the input
 * came from a browser. A null `rendered_text` is a failed fetch the collector
 * already recorded; text with no "Rated:" blocks is a genuinely dark day.
 *
 * The venue name/address is NOT extracted from the rendered text: the
 * collector already knows which of exactly 3 known venues it fetched, so it
 * attaches that directly -- simpler and more reliable than re-deriving it
 * from page text that has nothing to do with the venue's real address.
 *
 * Divergences from the Python: an impossible showtime ("7:75p") skips that
 * film with a warning, and a non-string field or bad context_date skips that
 * entry with a warning, instead of failing the whole source.
 */

import { type Event, type EventParser, MalformedRecord, ParseError, collectRecords, formatTime, inWeek, leadingIsoDate, makeEvent, parseJson, requireObject, str, to24Hour } from "./base.js";

const FILM_RE =
  /(?<title>[^\n]+)\n\nRated:\n(?<rating>[^\n]*)\nRuntime:\n(?<runtime>[^\n]+)\n\n(?<rest>.*?)(?=\n[^\n]+\n\nRated:\n|\nNEARBY THEATERS|$)/gs;
const TIME_RE = /\b(\d{1,2}):(\d{2})([ap])\b/g;

function film(match: RegExpMatchArray, venue: string, date: string, url: string): Event | null {
  const { title = "", rating = "", runtime = "", rest = "" } = match.groups ?? {};
  const times = [...rest.matchAll(TIME_RE)].map(([, h, m, meridiem = ""]) => formatTime(to24Hour(Number(h), meridiem), Number(m)));
  if (times.length === 0) return null;
  return makeEvent({
    title,
    venue,
    date,
    // Deduped in order: a film can repeat a showtime under more than one
    // screen format (e.g. Standard + 35mm).
    time: [...new Set(times)].join(", "),
    cost: "",
    url,
    description: `Rated ${rating.trim() || "Not Rated"}. Runtime: ${runtime.trim()}.`,
  });
}

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const payload = parseJson(raw);
  if (!Array.isArray(payload)) {
    throw new ParseError("response is not a JSON array of per-venue-per-day entries -- collector output shape may have changed");
  }

  return collectRecords("philadelphia-film-society", payload as unknown[], (entry): Event[] => {
    const item = requireObject(entry);
    const renderedText = str(item, "rendered_text");
    const contextDate = str(item, "context_date");
    if (!renderedText || !contextDate) return []; // a failed fetch, already in the collector's failed_requests
    const date = leadingIsoDate(contextDate);
    if (date === null || date.length !== contextDate.length) throw new MalformedRecord(`bad context_date ${contextDate}`);
    if (!inWeek(date, weekStart, weekEnd)) return [];

    const venueName = str(item, "venue_name");
    const venueAddress = str(item, "venue_address");
    const venue = venueAddress ? `${venueName}, ${venueAddress}` : venueName;
    const url = str(item, "theater_url");
    return collectRecords("philadelphia-film-society", renderedText.matchAll(FILM_RE), (m) => film(m, venue, date, url));
  });
};
