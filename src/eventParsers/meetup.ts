/**
 * meetup-ical -- shared parser for all 8 Meetup group iCal feeds
 * (`DTSTART;TZID=America/New_York`, so DTSTART is already Philadelphia wall
 * time). Rewrite of scripts/event_parsers/meetup.py.
 *
 * As with luma.ts, zero VEVENTs is valid -- several of these groups are
 * genuinely quiet for weeks -- and only a non-iCal response throws.
 * Meetup's iCal feeds carry no LOCATION for any event (as of 2026-11-15), so
 * an empty one means "unknown" and is reported as NO_VENUE, not "(online)"
 * (which mislabelled Claude Code Philly and TERROR TELE-THON, both in
 * person). Only a URL LOCATION is "(online)". `enrichVenues` then reads each
 * NO_VENUE event's venue off its Meetup page's embedded Apollo state.
 *
 * Divergences from the Python: an impossible hour/minute skips that event
 * with a warning (Python's datetime.time() raised and failed the whole
 * source); iCal unescaping/unfolding fixes are in ical.ts.
 */

import { type Event, type EventParser, ParseError, collectRecords, formatTime, inWeek, isoDate, makeEvent } from "./base.js";
import { parseVEvents, unescapeText } from "./ical.js";

export const NO_VENUE = "(venue not listed)";
export const ONLINE = "(online)";

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
    return makeEvent({
      title: unescapeText(item.SUMMARY ?? ""),
      venue: !location ? NO_VENUE : location.startsWith("http") ? ONLINE : location,
      date,
      time: formatTime(hour, minute),
      cost: "",
      url: item.URL ?? "",
      description: unescapeText(item.DESCRIPTION ?? ""),
    });
  });
};

interface ApolloEvent {
  eventType?: string;
  venue?: { __ref?: string } | null;
}
interface ApolloVenue {
  name?: string;
  address?: string;
}

/**
 * [venue, address] from a Meetup event page, [ONLINE, ""] for an online event,
 * or null when the page doesn't say. `venue` is "name, address" to match an
 * iCal LOCATION. Reads only this event's own `Event:<id>` entry, not the other
 * events a page embeds (a recurring series).
 */
export function venueFromEventPage(html: string, eventUrl: string): [string, string] | null {
  const id = /\/events\/(\d+)/.exec(eventUrl)?.[1];
  const json = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
  if (id === undefined || json === undefined) return null;
  let state: Record<string, unknown>;
  try {
    state = (JSON.parse(json) as { props: { pageProps: { __APOLLO_STATE__: Record<string, unknown> } } }).props.pageProps.__APOLLO_STATE__;
  } catch {
    return null;
  }
  const event = state[`Event:${id}`] as ApolloEvent | undefined;
  if (!event) return null;
  if (event.eventType === "ONLINE") return [ONLINE, ""];
  const ref = event.venue?.__ref;
  const venue = typeof ref === "string" ? (state[ref] as ApolloVenue | undefined) : undefined;
  if (!venue?.name) return null;
  const address = venue.address ?? "";
  return [address ? `${venue.name}, ${address}` : venue.name, address];
}

/**
 * Replaces NO_VENUE on each event, in place, from its Meetup page. A page that
 * can't be fetched or doesn't say leaves NO_VENUE (an honest "unknown");
 * returns one reason per failed fetch for the manifest note.
 */
export async function enrichVenues(events: Event[], fetchPage: (url: string) => Promise<string>): Promise<string[]> {
  const failed: string[] = [];
  for (const event of events) {
    if (event.venue !== NO_VENUE || !event.url) continue;
    let found: [string, string] | null;
    try {
      found = venueFromEventPage(await fetchPage(event.url), event.url);
    } catch (err) {
      failed.push(`${event.url} (${err instanceof Error ? err.name : "Error"})`);
      continue;
    }
    if (found) {
      event.venue = found[0];
      if (found[1]) event.venue_address = found[1];
    }
  }
  return failed;
}
