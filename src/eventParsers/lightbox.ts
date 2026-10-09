/**
 * lightbox-film-center -- two-stage source: a Wix-rendered homepage index,
 * then one JSON-LD `Event` block per detail page. Rewrite of
 * scripts/event_parsers/lightbox.py.
 *
 * Wix's own generated class names are hashed and unstable between builds, but
 * its widgets carry a separate, stable `data-hook` attribute contract --
 * `[data-hook="events-card"]` (one per upcoming screening),
 * `[data-hook="title"]` (the card's own `<a>`, so its `href` is the detail
 * page URL directly -- no separate title-vs-link element to reconcile).
 * Confirmed live 2026-07-29.
 *
 * The homepage index only gives a short, year-less date ("Wed, Jul 29") and a
 * bare venue name -- not enough to filter or place on a calendar reliably.
 * Each event's own detail page carries a complete, authoritative
 * `application/ld+json` `Event` block instead (`startDate` with year and
 * offset, full street `location.address`), so this parser trusts the detail
 * page entirely for filtering and field values; the index ({@link parseIndex})
 * is only used to enumerate which detail pages exist. The homepage typically
 * lists a small, bounded number of upcoming events (6, observed 2026-07-29),
 * so the collector fetches every listed detail page and hands {@link parse} a
 * JSON array of `{title, href, detail_html}`.
 *
 * A missing or unreachable detail page is not fatal to the whole source: Wix
 * returns 200 with its SPA shell even for a URL that doesn't resolve to a real
 * event (confirmed live), so a broken detail fetch just means no JSON-LD
 * Event block is found for that one candidate -- skipped, not thrown.
 *
 * One more real quirk: the page template HTML-escapes the JSON-LD payload
 * before embedding it, so decoded JSON string values still contain literal
 * `&amp;`-style entities and need entity-decoding on top of JSON.parse.
 *
 * Divergences from the Python:
 *
 * - `location.address` as a schema.org PostalAddress object is formatted
 *   ("street, locality, region postcode, country") instead of being written
 *   as a Python dict repr; a `location` that is a plain string or an array of
 *   places is read too.
 * - `"@type": ["Event"]` (an array) is accepted, as are JSON-LD blocks that
 *   are arrays or carry an `@graph`.
 * - The address is entity-decoded like the other fields.
 */

import { load } from "cheerio";
import { decodeHTML } from "entities";
import { type Event, type EventParser, type JsonObject, ParseError, attr, collectRecords, inWeek, isObject, makeEvent, parseIsoDateTime, parseJson, requireObject, str, text } from "./base.js";

export interface IndexCandidate {
  title: string;
  href: string;
}

/** Homepage HTML -> detail-page candidates. Throws ParseError if there are no event cards at all. */
export function parseIndex(pageHtml: string): IndexCandidate[] {
  const $ = load(pageHtml);
  const cards = $('[data-hook="events-card"]').toArray();
  if (cards.length === 0) throw new ParseError('no [data-hook="events-card"] blocks found -- markup may have changed');
  return cards.flatMap((card) => {
    const titleEl = $(card).find('[data-hook="title"]');
    const href = attr(titleEl, "href");
    return href ? [{ title: text(titleEl), href }] : [];
  });
}

function isEvent(node: JsonObject): boolean {
  const type = node["@type"];
  return type === "Event" || (Array.isArray(type) && type.includes("Event"));
}

function jsonLdNodes(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) return payload.flatMap(jsonLdNodes);
  if (!isObject(payload)) return [];
  return [payload, ...jsonLdNodes(payload["@graph"])];
}

export function extractJsonLdEvent(detailHtml: string): JsonObject | null {
  const $ = load(detailHtml);
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    let payload: unknown;
    try {
      payload = JSON.parse($(script).text()) as unknown;
    } catch {
      continue;
    }
    const event = jsonLdNodes(payload).find(isEvent);
    if (event) return event;
  }
  return null;
}

/** JSON-LD is loose about types; anything that isn't a string reads as "". */
function plain(node: JsonObject, key: string): string {
  const value = node[key];
  return typeof value === "string" ? decodeHTML(value).trim() : "";
}

function formatAddress(address: unknown): string {
  if (typeof address === "string") return decodeHTML(address).trim();
  if (!isObject(address)) return "";
  const regionPostcode = [plain(address, "addressRegion"), plain(address, "postalCode")].filter(Boolean).join(" ");
  return [plain(address, "streetAddress"), plain(address, "addressLocality"), regionPostcode, plain(address, "addressCountry")]
    .filter(Boolean)
    .join(", ");
}

function formatVenue(location: unknown): string {
  if (typeof location === "string") return decodeHTML(location).trim();
  const place = Array.isArray(location) ? (location as unknown[]).find(isObject) : location;
  if (!isObject(place)) return "";
  return [plain(place, "name"), formatAddress(place.address)].filter(Boolean).join(", ");
}

export const parse: EventParser = (raw, weekStart, weekEnd) => {
  const candidates = parseJson(raw);
  if (!Array.isArray(candidates)) {
    throw new ParseError("response is not a JSON array of candidates -- collector output shape may have changed");
  }

  return collectRecords("lightbox-film-center", candidates as unknown[], (entry): Event | null => {
    const candidate = requireObject(entry);
    const detailHtml = str(candidate, "detail_html");
    if (!detailHtml) return null; // the detail fetch failed; the collector already recorded it
    const ldEvent = extractJsonLdEvent(detailHtml);
    if (ldEvent === null) return null;

    const start = parseIsoDateTime(plain(ldEvent, "startDate"));
    if (start === null || !inWeek(start.date, weekStart, weekEnd)) return null;

    return makeEvent({
      title: plain(ldEvent, "name") || str(candidate, "title"),
      venue: formatVenue(ldEvent.location),
      date: start.date,
      time: start.time,
      cost: "",
      url: str(candidate, "href"),
      description: plain(ldEvent, "description"),
    });
  });
};
