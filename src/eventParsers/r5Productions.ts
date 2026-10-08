/**
 * r5-productions -- WordPress "RHP" events plugin. Rewrite of
 * scripts/event_parsers/r5_productions.py.
 *
 * One `div.rhp-event__info--list` per event, but its date (`#eventDate`,
 * "Thu, Oct 08", no year) sits in a sibling column of the same event card,
 * not inside the info block. The year comes from resolveYear, so a week
 * spanning New Year's resolves "Fri, Jan 1" to the arriving year. Titles are
 * "<tagline> | <title>" when the card has a `.eventTagLine`.
 *
 * Divergences from the Python:
 *
 * - The date is looked up only within the event's own card: the nearest
 *   ancestor that contains this info block and no other. Python's
 *   `find_previous(id="eventDate")` took the closest preceding #eventDate
 *   anywhere in the document, so an event with no date of its own silently
 *   borrowed the previous event's. Such an event is now skipped.
 * - The venue is the `.venueLink` title attribute, falling back to its text
 *   when the attribute is absent *or empty* (Python fell back only when absent).
 */

import { load } from "cheerio";
import { type EventParser, ParseError, attr, inWeek, isoDate, makeEvent, parseMonth, resolveYear, text } from "./base.js";

const INFO = "div.rhp-event__info--list";

export const parse: EventParser = (html, weekStart, weekEnd) => {
  const $ = load(html);
  const containers = $(INFO).toArray();
  if (containers.length === 0) throw new ParseError("no rhp-event__info--list blocks found -- markup may have changed");

  const ownDateText = (info: (typeof containers)[number]): string => {
    for (const ancestor of $(info).parents().toArray()) {
      const scope = $(ancestor);
      if (scope.find(INFO).length > 1) return "";
      const dateEl = scope.find('[id="eventDate"]');
      if (dateEl.length > 0) return text(dateEl);
    }
    return "";
  };

  return containers.flatMap((el) => {
    const info = $(el);
    const m = /(\w{3}),?\s+(\w{3})\s+(\d{1,2})/.exec(ownDateText(el));
    const month = m ? parseMonth(m[2] ?? "") : null;
    if (!m || month === null) return [];
    const day = Number(m[3]);
    const year = resolveYear(month, day, weekStart);
    const date = year === null ? null : isoDate(year, month, day);
    if (date === null || !inWeek(date, weekStart, weekEnd)) return [];

    const title = text(info.find("#eventTitle h2, .rhp-event__title--list"));
    const tagline = text(info.find(".eventTagLine"));
    const fullTitle = tagline && title ? `${tagline} | ${title}` : title || tagline;
    if (!fullTitle) return [];

    const venueLink = info.find(".venueLink");
    return [
      makeEvent({
        title: fullTitle,
        venue: attr(venueLink, "title") || text(venueLink),
        date,
        time: text(info.find(".rhp-event__time-text--list")),
        cost: text(info.find(".rhp-event__cost-text--list")),
        url: attr(info.find("#eventTitle"), "href") || "https://r5productions.com/events/",
        description: tagline,
      }),
    ];
  });
};
